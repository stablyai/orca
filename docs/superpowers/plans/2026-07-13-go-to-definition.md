# Go to Definition (Symbol Index) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Go to Definition" (Cmd+B when the editor is focused, plus F12 and Cmd+Click) to Orca's Monaco editor, backed by a tree-sitter symbol index built per worktree in the main process.

**Architecture:** The main process parses worktree files with web-tree-sitter, extracts definition symbols (functions, classes, methods, types, …), and keeps a per-worktree `name → SymbolDef[]` table. The renderer registers a Monaco `DefinitionProvider` that extracts the symbol under the cursor and queries the index over IPC. One match → open + reveal the file at the line; many → Monaco's peek widget; zero (or index not ready) → fall back to the existing "Search in Files" flow.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), Monaco (`monaco-editor` 0.55.1), `web-tree-sitter` (wasm), Vitest, Zustand store.

## Global Constraints

- Package manager is **pnpm** (repo uses `pnpm-lock.yaml`). Install deps with `pnpm add`.
- Tests are **Vitest**, colocated as `*.test.ts` next to the unit. Run a single file with `pnpm vitest run <path>`.
- IPC pattern: a main service class exposes `registerIpcHandlers()` calling `ipcMain.handle('symbol-index:<action>', …)`; preload exposes `ipcRenderer.invoke('symbol-index:<action>', args)`. Service is constructed and wired in `src/main/index.ts`.
- Shared types (used by main + renderer + preload) live under `src/shared/`.
- Language ids come from `detectLanguage(filePath)` in `src/renderer/src/lib/language-detect.ts`; the same mapping keys the parser's grammar selection.
- Keybinding `Mod+B` is already `sidebar.left.toggle` (global). `editor.goToDefinition` must only win **when the editor is focused**, resolved in the editor DOM capture phase (same pattern as `installEditorFindShortcut` in `src/renderer/src/components/editor/editor-shortcuts.ts`).
- 1st-wave languages: TypeScript, TSX, JavaScript, Python, Go, Rust, Java. Unsupported/unindexed → zero-result fallback, never an error.
- Never re-enable Monaco semantic/syntax validation (see the comment in `src/renderer/src/lib/monaco-setup.ts`). This feature does not touch diagnostics.

---

### Task 1: Shared symbol-index types & IPC contract

**Files:**
- Create: `src/shared/symbol-index.ts`
- Test: `src/shared/symbol-index.test.ts`

**Interfaces:**
- Produces:
  - `type SymbolKind = 'function'|'method'|'class'|'interface'|'type'|'variable'|'constant'|'enum'|'struct'|'trait'|'module'`
  - `type SymbolDef = { name: string; kind: SymbolKind; path: string; line: number; column: number }` (line/column are 1-based)
  - `type FindDefinitionsRequest = { worktreeId: string; worktreeRoot: string; symbol: string }`
  - `type FindDefinitionsResponse = { status: 'ready'|'indexing'; definitions: SymbolDef[] }`
  - `const SYMBOL_INDEX_IPC = { findDefinitions: 'symbol-index:findDefinitions', ensureIndexed: 'symbol-index:ensureIndexed' } as const`
  - `function isSymbolDef(v: unknown): v is SymbolDef`

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/symbol-index.test.ts
import { describe, expect, it } from 'vitest'
import { isSymbolDef, SYMBOL_INDEX_IPC } from './symbol-index'

describe('symbol-index shared contract', () => {
  it('exposes stable IPC channel names', () => {
    expect(SYMBOL_INDEX_IPC.findDefinitions).toBe('symbol-index:findDefinitions')
    expect(SYMBOL_INDEX_IPC.ensureIndexed).toBe('symbol-index:ensureIndexed')
  })

  it('validates a SymbolDef shape', () => {
    expect(
      isSymbolDef({ name: 'foo', kind: 'function', path: '/a.ts', line: 1, column: 1 })
    ).toBe(true)
    expect(isSymbolDef({ name: 'foo', kind: 'function', path: '/a.ts', line: 1 })).toBe(false)
    expect(isSymbolDef(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/symbol-index.test.ts`
Expected: FAIL — cannot find module `./symbol-index`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/symbol-index.ts
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module'

/** A definition site. line/column are 1-based. path is absolute. */
export type SymbolDef = {
  name: string
  kind: SymbolKind
  path: string
  line: number
  column: number
}

export type FindDefinitionsRequest = {
  worktreeId: string
  worktreeRoot: string
  symbol: string
}

export type FindDefinitionsResponse = {
  /** 'ready' = index answered; 'indexing' = not ready, caller should fall back. */
  status: 'ready' | 'indexing'
  definitions: SymbolDef[]
}

export const SYMBOL_INDEX_IPC = {
  findDefinitions: 'symbol-index:findDefinitions',
  ensureIndexed: 'symbol-index:ensureIndexed'
} as const

export function isSymbolDef(v: unknown): v is SymbolDef {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    typeof o.kind === 'string' &&
    typeof o.path === 'string' &&
    typeof o.line === 'number' &&
    typeof o.column === 'number'
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/shared/symbol-index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/symbol-index.ts src/shared/symbol-index.test.ts
git commit -m "feat(symbol-index): shared SymbolDef + IPC contract"
```

---

### Task 2: Pure in-memory index store

**Files:**
- Create: `src/main/symbol-index/index-store.ts`
- Test: `src/main/symbol-index/index-store.test.ts`

**Interfaces:**
- Consumes: `SymbolDef` from `src/shared/symbol-index.ts`.
- Produces:
  - `class SymbolIndexStore` with:
    - `setFileSymbols(worktreeId: string, absPath: string, defs: SymbolDef[]): void` — replaces all defs previously recorded for that file.
    - `removeFile(worktreeId: string, absPath: string): void`
    - `find(worktreeId: string, name: string): SymbolDef[]` — exact-name match, stable order (by path then line).
    - `hasWorktree(worktreeId: string): boolean`
    - `clearWorktree(worktreeId: string): void`
    - `fileCount(worktreeId: string): number`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/symbol-index/index-store.test.ts
import { describe, expect, it } from 'vitest'
import type { SymbolDef } from '../../shared/symbol-index'
import { SymbolIndexStore } from './index-store'

const def = (name: string, path: string, line: number): SymbolDef => ({
  name,
  kind: 'function',
  path,
  line,
  column: 1
})

describe('SymbolIndexStore', () => {
  it('finds symbols by exact name across files, ordered by path then line', () => {
    const s = new SymbolIndexStore()
    s.setFileSymbols('w1', '/b.ts', [def('foo', '/b.ts', 10)])
    s.setFileSymbols('w1', '/a.ts', [def('foo', '/a.ts', 5), def('bar', '/a.ts', 8)])
    expect(s.find('w1', 'foo')).toEqual([def('foo', '/a.ts', 5), def('foo', '/b.ts', 10)])
    expect(s.find('w1', 'bar')).toEqual([def('bar', '/a.ts', 8)])
    expect(s.find('w1', 'nope')).toEqual([])
  })

  it('setFileSymbols replaces prior defs for the same file', () => {
    const s = new SymbolIndexStore()
    s.setFileSymbols('w1', '/a.ts', [def('foo', '/a.ts', 5)])
    s.setFileSymbols('w1', '/a.ts', [def('baz', '/a.ts', 7)])
    expect(s.find('w1', 'foo')).toEqual([])
    expect(s.find('w1', 'baz')).toEqual([def('baz', '/a.ts', 7)])
  })

  it('removeFile and clearWorktree drop entries; worktrees are isolated', () => {
    const s = new SymbolIndexStore()
    s.setFileSymbols('w1', '/a.ts', [def('foo', '/a.ts', 5)])
    s.setFileSymbols('w2', '/a.ts', [def('foo', '/a.ts', 9)])
    s.removeFile('w1', '/a.ts')
    expect(s.find('w1', 'foo')).toEqual([])
    expect(s.find('w2', 'foo')).toEqual([def('foo', '/a.ts', 9)])
    expect(s.hasWorktree('w2')).toBe(true)
    s.clearWorktree('w2')
    expect(s.hasWorktree('w2')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/symbol-index/index-store.test.ts`
Expected: FAIL — cannot find module `./index-store`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/symbol-index/index-store.ts
import type { SymbolDef } from '../../shared/symbol-index'

type WorktreeIndex = {
  /** absPath -> defs declared in that file */
  byFile: Map<string, SymbolDef[]>
  /** symbol name -> set of absPaths that declare it (for fast lookup) */
  byName: Map<string, Set<string>>
}

export class SymbolIndexStore {
  private worktrees = new Map<string, WorktreeIndex>()

  private ensure(worktreeId: string): WorktreeIndex {
    let wt = this.worktrees.get(worktreeId)
    if (!wt) {
      wt = { byFile: new Map(), byName: new Map() }
      this.worktrees.set(worktreeId, wt)
    }
    return wt
  }

  setFileSymbols(worktreeId: string, absPath: string, defs: SymbolDef[]): void {
    const wt = this.ensure(worktreeId)
    this.detachFile(wt, absPath)
    wt.byFile.set(absPath, defs)
    for (const d of defs) {
      let set = wt.byName.get(d.name)
      if (!set) {
        set = new Set()
        wt.byName.set(d.name, set)
      }
      set.add(absPath)
    }
  }

  removeFile(worktreeId: string, absPath: string): void {
    const wt = this.worktrees.get(worktreeId)
    if (!wt) return
    this.detachFile(wt, absPath)
    wt.byFile.delete(absPath)
  }

  private detachFile(wt: WorktreeIndex, absPath: string): void {
    const prev = wt.byFile.get(absPath)
    if (!prev) return
    for (const d of prev) {
      const set = wt.byName.get(d.name)
      if (!set) continue
      set.delete(absPath)
      if (set.size === 0) wt.byName.delete(d.name)
    }
  }

  find(worktreeId: string, name: string): SymbolDef[] {
    const wt = this.worktrees.get(worktreeId)
    if (!wt) return []
    const paths = wt.byName.get(name)
    if (!paths) return []
    const out: SymbolDef[] = []
    for (const p of paths) {
      for (const d of wt.byFile.get(p) ?? []) {
        if (d.name === name) out.push(d)
      }
    }
    out.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
    return out
  }

  hasWorktree(worktreeId: string): boolean {
    return this.worktrees.has(worktreeId)
  }

  clearWorktree(worktreeId: string): void {
    this.worktrees.delete(worktreeId)
  }

  fileCount(worktreeId: string): number {
    return this.worktrees.get(worktreeId)?.byFile.size ?? 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/symbol-index/index-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/symbol-index/index-store.ts src/main/symbol-index/index-store.test.ts
git commit -m "feat(symbol-index): pure in-memory index store"
```

---

### Task 3: Language → grammar mapping + definition queries

This task isolates the language-specific configuration (which grammar and which tree-sitter query extracts definitions) from the parser runtime, so the parser stays small and languages are added by data.

**Files:**
- Create: `src/main/symbol-index/language-config.ts`
- Test: `src/main/symbol-index/language-config.test.ts`

**Interfaces:**
- Produces:
  - `type LanguageConfig = { languageId: string; grammarKey: string; query: string }` (`query` is a tree-sitter S-expression capturing `@name` on definition identifiers and `@kind.<kind>` markers)
  - `function getLanguageConfig(languageId: string): LanguageConfig | null`
  - `const SUPPORTED_LANGUAGE_IDS: readonly string[]`

The `languageId` values must match `detectLanguage()` output. Confirm them in Step 1 before writing the map.

- [ ] **Step 1: Confirm detectLanguage ids for target languages**

Run:
```bash
sed -n '114,220p' src/renderer/src/lib/language-detect.ts
```
Expected: a mapping of extensions → ids. Note the exact ids for `.ts .tsx .js .py .go .rs .java` (e.g. `typescript`, `typescriptreact` or `tsx`, `javascript`, `python`, `go`, `rust`, `java`). Use those exact strings as `languageId` keys below. If an id differs from the guess in Step 3, adjust the map to the real value.

- [ ] **Step 2: Write the failing test**

```ts
// src/main/symbol-index/language-config.test.ts
import { describe, expect, it } from 'vitest'
import { getLanguageConfig, SUPPORTED_LANGUAGE_IDS } from './language-config'

describe('language-config', () => {
  it('returns a config with a non-empty query for supported languages', () => {
    for (const id of SUPPORTED_LANGUAGE_IDS) {
      const cfg = getLanguageConfig(id)
      expect(cfg, id).not.toBeNull()
      expect(cfg!.query.length).toBeGreaterThan(0)
      expect(cfg!.grammarKey.length).toBeGreaterThan(0)
    }
  })

  it('returns null for unsupported languages', () => {
    expect(getLanguageConfig('plaintext')).toBeNull()
    expect(getLanguageConfig('markdown')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/main/symbol-index/language-config.test.ts`
Expected: FAIL — cannot find module `./language-config`.

- [ ] **Step 4: Write minimal implementation**

Replace the `languageId` string literals below with the exact ids confirmed in Step 1 if they differ.

```ts
// src/main/symbol-index/language-config.ts
export type LanguageConfig = {
  languageId: string
  /** key into the grammar-wasm registry (see parser.ts) */
  grammarKey: string
  /** tree-sitter query; capture the defined identifier as @name */
  query: string
}

const TS_QUERY = `
(function_declaration name: (identifier) @name)
(method_definition name: (property_identifier) @name)
(class_declaration name: (type_identifier) @name)
(interface_declaration name: (type_identifier) @name)
(type_alias_declaration name: (type_identifier) @name)
(enum_declaration name: (identifier) @name)
(variable_declarator name: (identifier) @name)
(public_field_definition name: (property_identifier) @name)
`

const PY_QUERY = `
(function_definition name: (identifier) @name)
(class_definition name: (identifier) @name)
`

const GO_QUERY = `
(function_declaration name: (identifier) @name)
(method_declaration name: (field_identifier) @name)
(type_spec name: (type_identifier) @name)
`

const RUST_QUERY = `
(function_item name: (identifier) @name)
(struct_item name: (type_identifier) @name)
(enum_item name: (type_identifier) @name)
(trait_item name: (type_identifier) @name)
(mod_item name: (identifier) @name)
`

const JAVA_QUERY = `
(class_declaration name: (identifier) @name)
(interface_declaration name: (identifier) @name)
(method_declaration name: (identifier) @name)
(enum_declaration name: (identifier) @name)
`

const CONFIGS: Record<string, LanguageConfig> = {
  typescript: { languageId: 'typescript', grammarKey: 'typescript', query: TS_QUERY },
  typescriptreact: { languageId: 'typescriptreact', grammarKey: 'tsx', query: TS_QUERY },
  javascript: { languageId: 'javascript', grammarKey: 'typescript', query: TS_QUERY },
  python: { languageId: 'python', grammarKey: 'python', query: PY_QUERY },
  go: { languageId: 'go', grammarKey: 'go', query: GO_QUERY },
  rust: { languageId: 'rust', grammarKey: 'rust', query: RUST_QUERY },
  java: { languageId: 'java', grammarKey: 'java', query: JAVA_QUERY }
}

export const SUPPORTED_LANGUAGE_IDS: readonly string[] = Object.keys(CONFIGS)

export function getLanguageConfig(languageId: string): LanguageConfig | null {
  return CONFIGS[languageId] ?? null
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/main/symbol-index/language-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/symbol-index/language-config.ts src/main/symbol-index/language-config.test.ts
git commit -m "feat(symbol-index): language->grammar/query config"
```

---

### Task 4: tree-sitter parser (extract SymbolDef[] from source)

Adds the `web-tree-sitter` dependency and grammar wasm assets, and wraps parsing behind a small interface. The grammar wasm files are loaded lazily by `grammarKey`.

**Files:**
- Modify: `package.json` (add dep)
- Create: `src/main/symbol-index/grammar-registry.ts`
- Create: `src/main/symbol-index/parser.ts`
- Test: `src/main/symbol-index/parser.test.ts`

**Interfaces:**
- Consumes: `SymbolDef` (shared), `getLanguageConfig` (Task 3).
- Produces:
  - `grammar-registry.ts`: `function grammarWasmPath(grammarKey: string): string | null` — absolute path to the `.wasm` for a grammar, resolvable in both dev and packaged builds.
  - `parser.ts`:
    - `async function initParser(): Promise<void>` — idempotent web-tree-sitter init.
    - `async function parseDefinitions(languageId: string, source: string, absPath: string): Promise<SymbolDef[]>` — returns `[]` for unsupported languages or parse failure (never throws for bad input).

- [ ] **Step 1: Install dependency and locate grammar wasm**

Run:
```bash
pnpm add web-tree-sitter
```
Then determine the exact `web-tree-sitter` major version and its API surface:
```bash
node -e "const p=require('web-tree-sitter/package.json');console.log(p.version)"
ls node_modules/web-tree-sitter
```
Expected: prints a version (e.g. `0.25.x`) and lists `tree-sitter.wasm` (the runtime wasm). Grammar `.wasm` files for TS/Python/Go/Rust/Java are obtained from the `@vscode/tree-sitter-wasm` package which ships prebuilt grammar wasm:
```bash
pnpm add -D @vscode/tree-sitter-wasm
ls node_modules/@vscode/tree-sitter-wasm/wasm | grep -Ei 'typescript|tsx|python|go|rust|java'
```
Expected: files like `tree-sitter-typescript.wasm`, `tree-sitter-python.wasm`, etc. Record the exact filenames — they key `grammar-registry.ts`. If a language's grammar is absent from that package, drop it from `CONFIGS` (Task 3) for the first wave and note it in the PR.

- [ ] **Step 2: Write the failing test**

```ts
// src/main/symbol-index/parser.test.ts
import { describe, expect, it, beforeAll } from 'vitest'
import { initParser, parseDefinitions } from './parser'

beforeAll(async () => {
  await initParser()
})

describe('parseDefinitions', () => {
  it('extracts function and class names from TypeScript', async () => {
    const src = ['export function alpha() {}', '', 'class Beta {', '  gamma() {}', '}'].join('\n')
    const defs = await parseDefinitions('typescript', src, '/w/a.ts')
    const names = defs.map((d) => d.name).sort()
    expect(names).toContain('alpha')
    expect(names).toContain('Beta')
    expect(names).toContain('gamma')
    const alpha = defs.find((d) => d.name === 'alpha')!
    expect(alpha.path).toBe('/w/a.ts')
    expect(alpha.line).toBe(1)
    expect(alpha.column).toBeGreaterThanOrEqual(1)
  })

  it('extracts def and class from Python', async () => {
    const src = ['def foo():', '    pass', '', 'class Bar:', '    pass'].join('\n')
    const defs = await parseDefinitions('python', src, '/w/a.py')
    expect(defs.map((d) => d.name).sort()).toEqual(['Bar', 'foo'])
  })

  it('returns [] for unsupported language and for garbage input', async () => {
    expect(await parseDefinitions('plaintext', 'whatever', '/w/a.txt')).toEqual([])
    expect(await parseDefinitions('typescript', '((((', '/w/a.ts')).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/main/symbol-index/parser.test.ts`
Expected: FAIL — cannot find module `./parser`.

- [ ] **Step 4: Write the grammar registry**

Use the exact filenames recorded in Step 1. `createRequire` resolves the package location in both dev and packaged (asar) builds; grammar wasm must be marked as an unpacked asset in electron-builder config (see Step 7).

```ts
// src/main/symbol-index/grammar-registry.ts
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/** grammarKey -> wasm filename inside @vscode/tree-sitter-wasm/wasm */
const WASM_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm'
}

let wasmDir: string | null = null

function resolveWasmDir(): string {
  if (wasmDir) return wasmDir
  const pkgJson = require.resolve('@vscode/tree-sitter-wasm/package.json')
  wasmDir = path.join(path.dirname(pkgJson), 'wasm')
  return wasmDir
}

export function grammarWasmPath(grammarKey: string): string | null {
  const file = WASM_FILES[grammarKey]
  if (!file) return null
  return path.join(resolveWasmDir(), file)
}

/** Path to the web-tree-sitter runtime wasm. */
export function runtimeWasmPath(): string {
  return require.resolve('web-tree-sitter/tree-sitter.wasm')
}
```

- [ ] **Step 5: Write the parser**

This uses the web-tree-sitter API for the version installed in Step 1. For `web-tree-sitter` ≥ 0.25 the named exports are `Parser`, `Language`, `Query`. If Step 1 showed an older version whose default export is the parser class, adapt the three import/init lines accordingly (the rest is identical).

```ts
// src/main/symbol-index/parser.ts
import { readFile } from 'node:fs/promises'
import { Language, Parser, Query } from 'web-tree-sitter'
import type { SymbolDef } from '../../shared/symbol-index'
import { getLanguageConfig } from './language-config'
import { grammarWasmPath, runtimeWasmPath } from './grammar-registry'

let initPromise: Promise<void> | null = null
const languages = new Map<string, Language>()
const queries = new Map<string, Query>()

export function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile: () => runtimeWasmPath()
    })
  }
  return initPromise
}

async function loadLanguage(grammarKey: string): Promise<Language | null> {
  const existing = languages.get(grammarKey)
  if (existing) return existing
  const wasm = grammarWasmPath(grammarKey)
  if (!wasm) return null
  const bytes = await readFile(wasm)
  const lang = await Language.load(bytes)
  languages.set(grammarKey, lang)
  return lang
}

export async function parseDefinitions(
  languageId: string,
  source: string,
  absPath: string
): Promise<SymbolDef[]> {
  const cfg = getLanguageConfig(languageId)
  if (!cfg) return []
  await initParser()
  const lang = await loadLanguage(cfg.grammarKey)
  if (!lang) return []

  const parser = new Parser()
  parser.setLanguage(lang)
  let tree
  try {
    tree = parser.parse(source)
  } catch {
    parser.delete()
    return []
  }
  if (!tree) {
    parser.delete()
    return []
  }

  let query = queries.get(cfg.grammarKey)
  if (!query) {
    query = new Query(lang, cfg.query)
    queries.set(cfg.grammarKey, query)
  }

  const out: SymbolDef[] = []
  try {
    for (const match of query.matches(tree.rootNode)) {
      for (const capture of match.captures) {
        if (capture.name !== 'name') continue
        const node = capture.node
        out.push({
          name: node.text,
          kind: 'function', // kind refinement is future work; name-based jump doesn't need it
          path: absPath,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1
        })
      }
    }
  } finally {
    tree.delete()
    parser.delete()
  }
  return out
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run src/main/symbol-index/parser.test.ts`
Expected: PASS (3 tests). If grammar wasm fails to load under Vitest, confirm the wasm path prints an existing file: `node -e "console.log(require('node:fs').existsSync(require('./…')))"` — fix `grammar-registry.ts` paths, not the test.

- [ ] **Step 7: Mark grammar wasm as unpacked in the packaged build**

Open the electron-builder config (find it):
```bash
grep -rn "asarUnpack\|\"files\"\|electron-builder" electron-builder.* package.json config 2>/dev/null | head
```
Add `node_modules/@vscode/tree-sitter-wasm/wasm/**` and `node_modules/web-tree-sitter/tree-sitter.wasm` to `asarUnpack` (create the array if absent). This ensures `createRequire`-resolved wasm files exist on disk at runtime in the packaged app.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml src/main/symbol-index/parser.ts src/main/symbol-index/grammar-registry.ts src/main/symbol-index/parser.test.ts electron-builder.*
git commit -m "feat(symbol-index): tree-sitter parser + grammar wasm registry"
```

---

### Task 5: Main-process service (scan, cache, IPC, incremental updates)

**Files:**
- Create: `src/main/symbol-index/service.ts`
- Create: `src/main/symbol-index/scan-worktree.ts`
- Test: `src/main/symbol-index/scan-worktree.test.ts`
- Test: `src/main/symbol-index/service.test.ts`

**Interfaces:**
- Consumes: `SymbolIndexStore` (Task 2), `parseDefinitions`/`initParser` (Task 4), `detectLanguageId` (below), `SYMBOL_INDEX_IPC`, `FindDefinitionsRequest/Response` (Task 1).
- Produces:
  - `scan-worktree.ts`: `async function listIndexableFiles(root: string, opts: { maxFiles: number }): Promise<string[]>` — walks `root`, skips `.git`/`node_modules`/dotdirs, honors a hard `maxFiles` cap, returns absolute paths whose extension maps to a supported language.
  - `service.ts`: `class SymbolIndexService { constructor(deps); registerIpcHandlers(): void; ensureIndexed(worktreeId, root): Promise<void>; onFileChanged(worktreeId, root, absPath): Promise<void>; onFileRemoved(worktreeId, absPath): void; dispose(): void }`
  - A local `languageIdForPath(absPath): string | null` mapping extension → the same ids as Task 3 (kept in `scan-worktree.ts`, exported for reuse).

- [ ] **Step 1: Write the failing test for scan-worktree**

```ts
// src/main/symbol-index/scan-worktree.test.ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listIndexableFiles, languageIdForPath } from './scan-worktree'

describe('scan-worktree', () => {
  it('lists supported files and skips node_modules/.git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-scan-'))
    await writeFile(path.join(root, 'a.ts'), 'export const x = 1')
    await writeFile(path.join(root, 'readme.md'), '# hi')
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'pkg', 'b.ts'), 'export const y = 2')
    await mkdir(path.join(root, '.git'), { recursive: true })
    await writeFile(path.join(root, '.git', 'c.ts'), 'export const z = 3')

    const files = await listIndexableFiles(root, { maxFiles: 100 })
    expect(files).toEqual([path.join(root, 'a.ts')])
  })

  it('maps extensions to language ids', () => {
    expect(languageIdForPath('/x/a.ts')).toBe('typescript')
    expect(languageIdForPath('/x/a.py')).toBe('python')
    expect(languageIdForPath('/x/a.md')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (missing module).

Run: `pnpm vitest run src/main/symbol-index/scan-worktree.test.ts`
Expected: FAIL — cannot find module `./scan-worktree`.

- [ ] **Step 3: Implement scan-worktree**

Align the extension map ids with the ones confirmed in Task 3 Step 1.

```ts
// src/main/symbol-index/scan-worktree.ts
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java'
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'out', 'build'])

export function languageIdForPath(absPath: string): string | null {
  return EXT_TO_LANGUAGE[path.extname(absPath).toLowerCase()] ?? null
}

export async function listIndexableFiles(
  root: string,
  opts: { maxFiles: number }
): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < opts.maxFiles) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= opts.maxFiles) break
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        const abs = path.join(dir, entry.name)
        if (languageIdForPath(abs)) out.push(abs)
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run it — expect PASS.**

Run: `pnpm vitest run src/main/symbol-index/scan-worktree.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for the service**

```ts
// src/main/symbol-index/service.test.ts
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SymbolIndexService } from './service'

describe('SymbolIndexService', () => {
  it('indexes a worktree and answers findDefinitions; unknown symbol is empty', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-svc-'))
    await writeFile(path.join(root, 'a.ts'), 'export function target() {}')
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)

    const hit = await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'target' })
    expect(hit.status).toBe('ready')
    expect(hit.definitions.map((d) => d.name)).toEqual(['target'])
    expect(hit.definitions[0]!.path).toBe(path.join(root, 'a.ts'))

    const miss = await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'nope' })
    expect(miss).toEqual({ status: 'ready', definitions: [] })
    svc.dispose()
  })

  it('reflects file changes incrementally', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-svc-'))
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'export function one() {}')
    const svc = new SymbolIndexService({ maxFiles: 100 })
    await svc.ensureIndexed('w1', root)

    await writeFile(file, 'export function two() {}')
    await svc.onFileChanged('w1', root, file)

    expect((await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'one' })).definitions).toEqual([])
    expect((await svc.findDefinitions({ worktreeId: 'w1', worktreeRoot: root, symbol: 'two' })).definitions.length).toBe(1)
    svc.dispose()
  })
})
```

- [ ] **Step 6: Run it — expect FAIL** (missing module).

Run: `pnpm vitest run src/main/symbol-index/service.test.ts`
Expected: FAIL — cannot find module `./service`.

- [ ] **Step 7: Implement the service**

`registerIpcHandlers` is exercised in Task 6/integration, not the unit test above (which calls methods directly). `ipcMain` is imported lazily inside `registerIpcHandlers` so the unit test doesn't need an Electron environment.

```ts
// src/main/symbol-index/service.ts
import { readFile } from 'node:fs/promises'
import type {
  FindDefinitionsRequest,
  FindDefinitionsResponse
} from '../../shared/symbol-index'
import { SYMBOL_INDEX_IPC } from '../../shared/symbol-index'
import { SymbolIndexStore } from './index-store'
import { parseDefinitions } from './parser'
import { languageIdForPath, listIndexableFiles } from './scan-worktree'

type Deps = { maxFiles?: number }

export class SymbolIndexService {
  private store = new SymbolIndexStore()
  private indexing = new Map<string, Promise<void>>()
  private maxFiles: number

  constructor(deps: Deps = {}) {
    this.maxFiles = deps.maxFiles ?? 20_000
  }

  async ensureIndexed(worktreeId: string, root: string): Promise<void> {
    if (this.store.hasWorktree(worktreeId)) return
    let job = this.indexing.get(worktreeId)
    if (!job) {
      job = this.indexWorktree(worktreeId, root)
      this.indexing.set(worktreeId, job)
    }
    await job
  }

  private async indexWorktree(worktreeId: string, root: string): Promise<void> {
    try {
      const files = await listIndexableFiles(root, { maxFiles: this.maxFiles })
      for (const abs of files) {
        await this.indexFile(worktreeId, abs)
      }
      // Ensure the worktree is registered even if it had zero indexable files.
      if (!this.store.hasWorktree(worktreeId)) {
        this.store.setFileSymbols(worktreeId, `${root}/.orca-index-sentinel`, [])
      }
    } finally {
      this.indexing.delete(worktreeId)
    }
  }

  private async indexFile(worktreeId: string, abs: string): Promise<void> {
    const languageId = languageIdForPath(abs)
    if (!languageId) return
    let source: string
    try {
      source = await readFile(abs, 'utf8')
    } catch {
      return
    }
    const defs = await parseDefinitions(languageId, source, abs)
    this.store.setFileSymbols(worktreeId, abs, defs)
  }

  async onFileChanged(worktreeId: string, root: string, abs: string): Promise<void> {
    if (!this.store.hasWorktree(worktreeId)) {
      await this.ensureIndexed(worktreeId, root)
      return
    }
    await this.indexFile(worktreeId, abs)
  }

  onFileRemoved(worktreeId: string, abs: string): void {
    this.store.removeFile(worktreeId, abs)
  }

  async findDefinitions(req: FindDefinitionsRequest): Promise<FindDefinitionsResponse> {
    if (!this.store.hasWorktree(req.worktreeId)) {
      // Kick off indexing in the background; tell the caller to fall back now.
      void this.ensureIndexed(req.worktreeId, req.worktreeRoot)
      return { status: 'indexing', definitions: [] }
    }
    return { status: 'ready', definitions: this.store.find(req.worktreeId, req.symbol) }
  }

  registerIpcHandlers(): void {
    // Lazy import keeps this module unit-testable without Electron.
    const { ipcMain } = require('electron') as typeof import('electron')
    ipcMain.handle(SYMBOL_INDEX_IPC.findDefinitions, (_e, req: FindDefinitionsRequest) =>
      this.findDefinitions(req)
    )
    ipcMain.handle(
      SYMBOL_INDEX_IPC.ensureIndexed,
      (_e, args: { worktreeId: string; worktreeRoot: string }) =>
        this.ensureIndexed(args.worktreeId, args.worktreeRoot)
    )
  }

  dispose(): void {
    this.indexing.clear()
  }
}
```

- [ ] **Step 8: Run it — expect PASS.**

Run: `pnpm vitest run src/main/symbol-index/service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add src/main/symbol-index/service.ts src/main/symbol-index/scan-worktree.ts src/main/symbol-index/service.test.ts src/main/symbol-index/scan-worktree.test.ts
git commit -m "feat(symbol-index): main service with scan, cache, incremental IPC"
```

---

### Task 6: Wire service into main startup + watcher; expose over preload

**Files:**
- Modify: `src/main/index.ts` (construct service, register IPC, hook file watcher)
- Create: `src/preload/symbol-index.ts`
- Modify: preload aggregation + typed API surface (locate in Steps below)

**Interfaces:**
- Consumes: `SymbolIndexService` (Task 5), `SYMBOL_INDEX_IPC` (Task 1).
- Produces (renderer-facing, via `window`): `symbolIndex.findDefinitions(req: FindDefinitionsRequest): Promise<FindDefinitionsResponse>` and `symbolIndex.ensureIndexed(args): Promise<void>`.

- [ ] **Step 1: Find the preload aggregation + a watcher hook point**

Run:
```bash
grep -rn "contextBridge.exposeInMainWorld\|exposeInMainWorld" src/preload | head
grep -rn "import { gitlab }\|from './gitlab'" src/preload/index.ts | head
grep -rn "on file change\|watcher\|chokidar\|FSWatcher\|worktree.*watch\|fileChanged" src/main | grep -iv test | head
```
Expected: the `exposeInMainWorld` call and its API object (mirror how `gitlab` preload is added). And a main-process file/worktree watcher where per-file change events fire — the hook point for `onFileChanged`/`onFileRemoved`. If no central watcher exists, index lazily only (skip Step 4's watcher wiring) and rely on `ensureIndexed` + `onFileChanged` being called from the editor save path (note this in the PR).

- [ ] **Step 2: Create the preload module**

```ts
// src/preload/symbol-index.ts
import { ipcRenderer } from 'electron'
import {
  SYMBOL_INDEX_IPC,
  type FindDefinitionsRequest,
  type FindDefinitionsResponse
} from '../shared/symbol-index'

export const symbolIndex = {
  findDefinitions: (req: FindDefinitionsRequest): Promise<FindDefinitionsResponse> =>
    ipcRenderer.invoke(SYMBOL_INDEX_IPC.findDefinitions, req),
  ensureIndexed: (args: { worktreeId: string; worktreeRoot: string }): Promise<void> =>
    ipcRenderer.invoke(SYMBOL_INDEX_IPC.ensureIndexed, args)
}
```

- [ ] **Step 3: Register `symbolIndex` on the exposed API**

In the preload aggregation file found in Step 1 (same file/object that exposes `gitlab`), import and add `symbolIndex`:

```ts
import { symbolIndex } from './symbol-index'
// …inside the exposed api object:
  symbolIndex,
```

Add the matching type to the renderer's `window` API typing next to where `gitlab`'s type lives (Step 1 grep shows the file). Example addition to the API interface:

```ts
  symbolIndex: {
    findDefinitions: (
      req: import('../shared/symbol-index').FindDefinitionsRequest
    ) => Promise<import('../shared/symbol-index').FindDefinitionsResponse>
    ensureIndexed: (args: { worktreeId: string; worktreeRoot: string }) => Promise<void>
  }
```

- [ ] **Step 4: Construct the service and register IPC in main**

In `src/main/index.ts`, next to the other service constructions (e.g. near `starNag`/`rateLimits` around lines 1670–1740), add:

```ts
import { SymbolIndexService } from './symbol-index/service'
// module-scope singleton, alongside other `let xService: … | null = null` decls:
let symbolIndexService: SymbolIndexService | null = null
// where services are constructed at startup:
symbolIndexService = new SymbolIndexService()
symbolIndexService.registerIpcHandlers()
```

If a central per-file watcher was found in Step 1, wire it:

```ts
// wherever a file-change event is dispatched with (worktreeId, worktreeRoot, absPath):
symbolIndexService?.onFileChanged(worktreeId, worktreeRoot, absPath)
// and for deletes:
symbolIndexService?.onFileRemoved(worktreeId, absPath)
```

- [ ] **Step 5: Typecheck + build main/preload**

Run:
```bash
pnpm typecheck
```
Expected: no new type errors referencing `symbolIndex` or `SymbolIndexService`. (If the repo lacks a `typecheck` script, run `pnpm exec tsc -p tsconfig.json --noEmit` or the config the repo uses — discover via `grep -n '"typecheck"\|"build"' package.json`.)

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/preload/symbol-index.ts src/preload/*.ts src/renderer/src/**/window*.d.ts
git commit -m "feat(symbol-index): wire main service + preload bridge"
```

---

### Task 7: `editor.goToDefinition` keybinding

**Files:**
- Modify: `src/shared/keybindings.ts` (add action id + default entry)
- Test: `src/shared/keybindings.test.ts` (add case; create if absent)

**Interfaces:**
- Produces: `KeybindingActionId` union gains `'editor.goToDefinition'`; a default entry bound to `Mod+B` and `F12`.

- [ ] **Step 1: Write the failing test**

If `src/shared/keybindings.test.ts` exists, add this case; otherwise create the file.

```ts
// src/shared/keybindings.test.ts (add to existing or new)
import { describe, expect, it } from 'vitest'
import { KEYBINDING_DEFINITIONS } from './keybindings'

describe('editor.goToDefinition keybinding', () => {
  it('is defined with default Mod+B and F12', () => {
    const entry = KEYBINDING_DEFINITIONS.find((d) => d.id === 'editor.goToDefinition')
    expect(entry, 'editor.goToDefinition must exist').toBeDefined()
    const macBindings = entry!.defaultBindings.mac ?? entry!.defaultBindings.default ?? []
    expect(macBindings.join(',')).toContain('Mod+B')
    expect(macBindings.join(',')).toContain('F12')
  })
})
```

Note: confirm the exported array's name and `defaultBindings` shape first:
```bash
grep -n "export const .*Definition\|export const KEYBINDING\|defaultBindings\|platformBindings" src/shared/keybindings.ts | head
```
Adjust `KEYBINDING_DEFINITIONS` / `.mac` / `.default` in the test to the real exported name and shape.

- [ ] **Step 2: Run it — expect FAIL.**

Run: `pnpm vitest run src/shared/keybindings.test.ts`
Expected: FAIL — entry undefined.

- [ ] **Step 3: Add the action id and entry**

Add to the `KeybindingActionId` union (near `'editor.find'` at line 88):

```ts
  | 'editor.goToDefinition'
```

Add the definition entry near the other `editor.*` entries. `platformBindings([...])` accepts multiple bindings (see `worktree` entries that pass two). Bind both `Mod+B` and `F12`:

```ts
  {
    id: 'editor.goToDefinition',
    title: 'Go to Definition',
    group: 'Editor',
    scope: 'editor',
    searchKeywords: ['shortcut', 'editor', 'go to definition', 'jump', 'symbol', 'declaration'],
    defaultBindings: platformBindings(['Mod+B', 'F12'])
  },
```

If `scope` only accepts specific literals and `'editor'` is not one, use the same `scope` value the other `editor.*` entries use (check `editor.find`'s entry at line ~786).

- [ ] **Step 4: Run it — expect PASS.**

Run: `pnpm vitest run src/shared/keybindings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/keybindings.ts src/shared/keybindings.test.ts
git commit -m "feat(symbol-index): add editor.goToDefinition keybinding (Mod+B/F12)"
```

---

### Task 8: Renderer definition resolver (symbol under cursor → open/peek/fallback)

Pure logic first: given a store query result, decide the action. Kept separate from Monaco/React so it is unit-testable.

**Files:**
- Create: `src/renderer/src/components/editor/resolve-go-to-definition.ts`
- Test: `src/renderer/src/components/editor/resolve-go-to-definition.test.ts`

**Interfaces:**
- Consumes: `FindDefinitionsResponse`, `SymbolDef` (shared).
- Produces:
  - `type GoToDefinitionOutcome = { kind: 'open'; target: SymbolDef } | { kind: 'peek'; targets: SymbolDef[] } | { kind: 'fallback' }`
  - `function resolveGoToDefinition(response: FindDefinitionsResponse, currentPath: string, currentLine: number): GoToDefinitionOutcome`
  - Rules: `status==='indexing'` or empty → `fallback`. One def → `open`. Multiple → `peek`. If the only def is the cursor's own line in the current file (self-hit), treat as `fallback` so Cmd+B on a definition still does something useful.

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/components/editor/resolve-go-to-definition.test.ts
import { describe, expect, it } from 'vitest'
import type { SymbolDef } from '../../../../shared/symbol-index'
import { resolveGoToDefinition } from './resolve-go-to-definition'

const def = (path: string, line: number): SymbolDef => ({
  name: 'foo',
  kind: 'function',
  path,
  line,
  column: 1
})

describe('resolveGoToDefinition', () => {
  it('falls back when indexing or empty', () => {
    expect(resolveGoToDefinition({ status: 'indexing', definitions: [] }, '/a.ts', 1).kind).toBe('fallback')
    expect(resolveGoToDefinition({ status: 'ready', definitions: [] }, '/a.ts', 1).kind).toBe('fallback')
  })

  it('opens a single distinct definition', () => {
    const out = resolveGoToDefinition({ status: 'ready', definitions: [def('/b.ts', 4)] }, '/a.ts', 1)
    expect(out).toEqual({ kind: 'open', target: def('/b.ts', 4) })
  })

  it('peeks when multiple definitions exist', () => {
    const out = resolveGoToDefinition(
      { status: 'ready', definitions: [def('/b.ts', 4), def('/c.ts', 9)] },
      '/a.ts',
      1
    )
    expect(out.kind).toBe('peek')
  })

  it('falls back when the only hit is the cursor line itself', () => {
    const out = resolveGoToDefinition({ status: 'ready', definitions: [def('/a.ts', 7)] }, '/a.ts', 7)
    expect(out.kind).toBe('fallback')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (missing module).

Run: `pnpm vitest run src/renderer/src/components/editor/resolve-go-to-definition.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/renderer/src/components/editor/resolve-go-to-definition.ts
import type { FindDefinitionsResponse, SymbolDef } from '../../../../shared/symbol-index'

export type GoToDefinitionOutcome =
  | { kind: 'open'; target: SymbolDef }
  | { kind: 'peek'; targets: SymbolDef[] }
  | { kind: 'fallback' }

export function resolveGoToDefinition(
  response: FindDefinitionsResponse,
  currentPath: string,
  currentLine: number
): GoToDefinitionOutcome {
  if (response.status !== 'ready' || response.definitions.length === 0) {
    return { kind: 'fallback' }
  }
  const defs = response.definitions
  if (defs.length === 1) {
    const only = defs[0]!
    if (only.path === currentPath && only.line === currentLine) {
      return { kind: 'fallback' }
    }
    return { kind: 'open', target: only }
  }
  return { kind: 'peek', targets: defs }
}
```

- [ ] **Step 4: Run it — expect PASS.**

Run: `pnpm vitest run src/renderer/src/components/editor/resolve-go-to-definition.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/editor/resolve-go-to-definition.ts src/renderer/src/components/editor/resolve-go-to-definition.test.ts
git commit -m "feat(symbol-index): pure go-to-definition outcome resolver"
```

---

### Task 9: Monaco integration — action, provider, editor-scoped Cmd+B, open/peek/fallback

Ties everything together in `MonacoEditor.tsx`, mirroring the existing `orca.searchInFiles` action wiring.

**Files:**
- Create: `src/renderer/src/components/editor/go-to-definition-controller.ts`
- Test: `src/renderer/src/components/editor/go-to-definition-controller.test.ts`
- Modify: `src/renderer/src/components/editor/editor-shortcuts.ts` (add `installEditorGoToDefinitionShortcut`)
- Modify: `src/renderer/src/components/editor/MonacoEditor.tsx` (register action + shortcut + definition provider)

**Interfaces:**
- Consumes: `resolveGoToDefinition` (Task 8), `getMonacoCodebaseSearchQuery` (existing), `openFile`/`setPendingEditorReveal` (store), `window.symbolIndex` (Task 6), `editorShortcutMatches` (existing).
- Produces:
  - `editor-shortcuts.ts`: `function installEditorGoToDefinitionShortcut(target: HTMLElement, onTrigger: () => void): () => void` (capture-phase, matches `editor.goToDefinition`, `preventDefault`+`stopPropagation`, ignores repeats — same shape as `installEditorFindShortcut`).
  - `go-to-definition-controller.ts`: `async function runGoToDefinition(ctx: GoToDefinitionContext): Promise<void>` where
    ```ts
    type GoToDefinitionContext = {
      worktreeId: string | null
      worktreeRoot: string | null
      currentPath: string
      currentLine: number
      symbol: string | null
      find: (req: FindDefinitionsRequest) => Promise<FindDefinitionsResponse>
      openAt: (target: SymbolDef) => void        // openFile + setPendingEditorReveal
      peek: (targets: SymbolDef[]) => void        // Monaco peek widget
      fallback: () => void                        // existing Search-in-Files
    }
    ```

- [ ] **Step 1: Write the failing test for the controller**

```ts
// src/renderer/src/components/editor/go-to-definition-controller.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { FindDefinitionsResponse, SymbolDef } from '../../../../shared/symbol-index'
import { runGoToDefinition } from './go-to-definition-controller'

const target: SymbolDef = { name: 'foo', kind: 'function', path: '/b.ts', line: 3, column: 2 }

function ctx(overrides: Partial<Parameters<typeof runGoToDefinition>[0]> = {}) {
  return {
    worktreeId: 'w1',
    worktreeRoot: '/w',
    currentPath: '/a.ts',
    currentLine: 1,
    symbol: 'foo',
    find: vi.fn(async (): Promise<FindDefinitionsResponse> => ({ status: 'ready', definitions: [target] })),
    openAt: vi.fn(),
    peek: vi.fn(),
    fallback: vi.fn(),
    ...overrides
  }
}

describe('runGoToDefinition', () => {
  it('opens the single definition', async () => {
    const c = ctx()
    await runGoToDefinition(c)
    expect(c.openAt).toHaveBeenCalledWith(target)
    expect(c.fallback).not.toHaveBeenCalled()
  })

  it('falls back when no symbol under cursor', async () => {
    const c = ctx({ symbol: null })
    await runGoToDefinition(c)
    expect(c.find).not.toHaveBeenCalled()
    expect(c.fallback).toHaveBeenCalledOnce()
  })

  it('falls back when worktree is missing', async () => {
    const c = ctx({ worktreeId: null })
    await runGoToDefinition(c)
    expect(c.fallback).toHaveBeenCalledOnce()
  })

  it('peeks on multiple definitions', async () => {
    const second: SymbolDef = { ...target, path: '/c.ts', line: 9 }
    const c = ctx({
      find: vi.fn(async () => ({ status: 'ready', definitions: [target, second] }))
    })
    await runGoToDefinition(c)
    expect(c.peek).toHaveBeenCalledWith([target, second])
  })

  it('falls back when the index reports indexing', async () => {
    const c = ctx({ find: vi.fn(async () => ({ status: 'indexing', definitions: [] })) })
    await runGoToDefinition(c)
    expect(c.fallback).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (missing module).

Run: `pnpm vitest run src/renderer/src/components/editor/go-to-definition-controller.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the controller**

```ts
// src/renderer/src/components/editor/go-to-definition-controller.ts
import type {
  FindDefinitionsRequest,
  FindDefinitionsResponse,
  SymbolDef
} from '../../../../shared/symbol-index'
import { resolveGoToDefinition } from './resolve-go-to-definition'

export type GoToDefinitionContext = {
  worktreeId: string | null
  worktreeRoot: string | null
  currentPath: string
  currentLine: number
  symbol: string | null
  find: (req: FindDefinitionsRequest) => Promise<FindDefinitionsResponse>
  openAt: (target: SymbolDef) => void
  peek: (targets: SymbolDef[]) => void
  fallback: () => void
}

export async function runGoToDefinition(ctx: GoToDefinitionContext): Promise<void> {
  if (!ctx.symbol || !ctx.worktreeId || !ctx.worktreeRoot) {
    ctx.fallback()
    return
  }
  const response = await ctx.find({
    worktreeId: ctx.worktreeId,
    worktreeRoot: ctx.worktreeRoot,
    symbol: ctx.symbol
  })
  const outcome = resolveGoToDefinition(response, ctx.currentPath, ctx.currentLine)
  if (outcome.kind === 'open') ctx.openAt(outcome.target)
  else if (outcome.kind === 'peek') ctx.peek(outcome.targets)
  else ctx.fallback()
}
```

- [ ] **Step 4: Run it — expect PASS.**

Run: `pnpm vitest run src/renderer/src/components/editor/go-to-definition-controller.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the editor-scoped shortcut installer**

Append to `src/renderer/src/components/editor/editor-shortcuts.ts` (mirrors `installEditorFindShortcut`):

```ts
export function installEditorGoToDefinitionShortcut(
  target: HTMLElement,
  onTrigger: () => void
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!editorShortcutMatches('editor.goToDefinition', event)) {
      return
    }
    // Why: capture-phase preventDefault beats the global sidebar.left.toggle
    // (Mod+B) binding, but only while the editor DOM has focus.
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) {
      onTrigger()
    }
  }
  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}
```

- [ ] **Step 6: Wire into MonacoEditor.tsx**

In `src/renderer/src/components/editor/MonacoEditor.tsx`, near the existing `orca.searchInFiles` action (around line 405–422), add the imports at top:

```ts
import { installEditorGoToDefinitionShortcut } from './editor-shortcuts'
import { runGoToDefinition } from './go-to-definition-controller'
```

Define a trigger that reuses the existing symbol extraction and the store, then register both a Monaco action and the capture-phase shortcut. `worktreeRoot` and `relativePath` come from the same props/state the `searchInFiles` action uses (`worktreeId` is already in scope; get `worktreeRoot` the same way other editor code resolves it — grep `worktreeRoot` in this file). Insert after `searchInFilesAction`:

```ts
      const triggerGoToDefinition = (): void => {
        const state = useAppStore.getState()
        const model = editorInstance.getModel()
        const position = editorInstance.getPosition()
        const symbol = getMonacoCodebaseSearchQuery(model, editorInstance.getSelection(), position)
        void runGoToDefinition({
          worktreeId: worktreeId ?? null,
          worktreeRoot: worktreeRoot ?? null,
          currentPath: filePath,
          currentLine: position?.lineNumber ?? 1,
          symbol,
          find: (req) => window.symbolIndex.findDefinitions(req),
          openAt: (t) => {
            state.openFile({
              filePath: t.path,
              relativePath: t.path.startsWith((worktreeRoot ?? '') + '/')
                ? t.path.slice((worktreeRoot ?? '').length + 1)
                : t.path,
              worktreeId: worktreeId!,
              language: detectLanguage(t.path),
              mode: 'edit'
            })
            state.setPendingEditorReveal({
              filePath: t.path,
              line: t.line,
              column: t.column,
              matchLength: 0
            })
          },
          peek: (targets) => {
            // Monaco's built-in peek: register a one-shot definition provider result
            // by invoking the editor's reveal-definition with our locations.
            editorInstance.setPosition(position ?? { lineNumber: 1, column: 1 })
            editorInstance.trigger('orca.goToDefinition', 'editor.action.peekDefinition', {
              locations: targets.map((t) => ({
                uri: monaco.Uri.file(t.path),
                range: {
                  startLineNumber: t.line,
                  startColumn: t.column,
                  endLineNumber: t.line,
                  endColumn: t.column
                }
              }))
            })
          },
          fallback: () => {
            if (symbol) state.showRightSidebarSearch({ query: symbol })
          }
        })
      }

      const goToDefinitionAction = editorInstance.addAction({
        id: 'orca.goToDefinition',
        label: translate('auto.components.editor.MonacoEditor.goToDefinition', 'Go to Definition'),
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1,
        run: () => triggerGoToDefinition()
      })
      const cleanupGoToDefinitionShortcut = installEditorGoToDefinitionShortcut(
        editorDomNode,
        triggerGoToDefinition
      )
```

Register a Monaco `DefinitionProvider` once (module-scope guard) so F12/Cmd+Click route through the same logic. Add near `monaco-setup` usage or in `MonacoEditor.tsx` mount:

```ts
      // Cmd+Click / F12 path: Monaco asks the provider for definitions.
      const definitionProviderDisposable = monaco.languages.registerDefinitionProvider(
        { pattern: '**/*' },
        {
          provideDefinition: async (model, pos) => {
            const symbol = getMonacoCodebaseSearchQuery(model, null, pos)
            if (!symbol || !worktreeId || !worktreeRoot) return []
            const res = await window.symbolIndex.findDefinitions({
              worktreeId,
              worktreeRoot,
              symbol
            })
            if (res.status !== 'ready') return []
            return res.definitions.map((d) => ({
              uri: monaco.Uri.file(d.path),
              range: {
                startLineNumber: d.line,
                startColumn: d.column,
                endLineNumber: d.line,
                endColumn: d.column
              }
            }))
          }
        }
      )
```

Add all three disposables to the editor's existing cleanup return (where `searchInFilesAction.dispose()`, `cleanupSaveShortcut()`, etc. are disposed):

```ts
      // in the cleanup function:
      goToDefinitionAction.dispose()
      cleanupGoToDefinitionShortcut()
      definitionProviderDisposable.dispose()
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors. Fix real signature mismatches (e.g. exact `openFile` field names, `worktreeRoot` source) by matching what `MonacoEditor.tsx` / the store already use — do not change the store API.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/editor/editor-shortcuts.ts src/renderer/src/components/editor/go-to-definition-controller.ts src/renderer/src/components/editor/go-to-definition-controller.test.ts src/renderer/src/components/editor/MonacoEditor.tsx
git commit -m "feat(symbol-index): Monaco go-to-definition action, provider, Cmd+B/F12"
```

---

### Task 10: End-to-end verification + PR polish

**Files:**
- Modify: none required (verification); update `CHANGELOG`/docs only if the repo has them.

- [ ] **Step 1: Run the full symbol-index test set**

Run: `pnpm vitest run src/main/symbol-index src/renderer/src/components/editor/resolve-go-to-definition.test.ts src/renderer/src/components/editor/go-to-definition-controller.test.ts src/shared/symbol-index.test.ts src/shared/keybindings.test.ts`
Expected: all PASS.

- [ ] **Step 2: Lint + typecheck the whole project**

Run: `pnpm lint && pnpm typecheck`
Expected: clean (or no *new* findings attributable to these files). Discover exact script names via `grep -n '"lint"\|"typecheck"' package.json`.

- [ ] **Step 3: Manual smoke test in the running app**

Run the app (`pnpm dev` or the repo's documented dev command — check `README.md`/`CONTRIBUTING.md`). Then, per `superpowers:verification-before-completion`, exercise the real flow:
1. Open a worktree with TS/Python code.
2. Open a file, put the cursor on a call to a function defined elsewhere in the worktree.
3. Press Cmd+B → editor opens the defining file at the definition line.
4. F12 and Cmd+Click on the same symbol → same result (via the provider).
5. Cmd+B with no editor focus → left sidebar still toggles (no regression).
6. Cmd+B on a symbol with two same-named definitions → peek widget lists both.
7. Cmd+B on an unknown symbol → Search-in-Files sidebar opens (fallback).

Record the observed result for each of the 7 checks.

- [ ] **Step 4: Commit any doc updates and open the PR**

```bash
git add -A
git commit -m "docs: note go-to-definition feature" || echo "no doc changes"
```
Open a PR against `stablyai/orca:main` from `feat/go-to-definition`. In the description, state the name-based-index limitation explicitly (echoing the existing `until Orca has semantic LSP references` comment), list supported languages, and note the editor-scoped Cmd+B resolution for the sidebar-toggle conflict.

---

## Self-Review

**Spec coverage:**
- Symbol index in main process → Tasks 2, 5. ✅
- tree-sitter engine → Task 4. ✅
- Monaco DefinitionProvider + action → Task 9. ✅
- Cmd+B (editor-scoped) + F12 + Cmd+Click → Tasks 7, 9. ✅
- Single→jump / multiple→peek / zero→Search-in-Files fallback → Tasks 8, 9. ✅
- Per-worktree, incremental updates → Task 5 (`onFileChanged`/`onFileRemoved`), Task 6 (watcher hook). ✅
- 1st-wave languages TS/JS/TSX/Python/Go/Rust/Java → Tasks 3, 5. ✅
- Name-based limitation acknowledged in code/PR → Task 4 (kind comment), Task 10 Step 4. ✅
- Tests colocated, pure units isolated → every task. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The few "confirm X in the repo" steps carry the exact grep/sed command and how to adjust — these are verification steps against real code, not deferred work.

**Type consistency:** `SymbolDef`, `FindDefinitionsRequest/Response`, `SYMBOL_INDEX_IPC` defined in Task 1 and consumed unchanged in Tasks 2/5/6/8/9. `SymbolIndexService` methods (`ensureIndexed`, `findDefinitions`, `onFileChanged`, `onFileRemoved`, `registerIpcHandlers`, `dispose`) match between Task 5 definition and Task 6 usage. `resolveGoToDefinition` (Task 8) and `runGoToDefinition` (Task 9) signatures align. `getLanguageConfig`/`SUPPORTED_LANGUAGE_IDS` (Task 3) consumed by Task 4. `languageIdForPath`/`listIndexableFiles` (Task 5) consumed within Task 5 and Task 6.

**Known runtime-confirmation points (intentional, not placeholders):** exact `detectLanguage` ids (Task 3 Step 1), `web-tree-sitter` version/API + grammar wasm filenames (Task 4 Step 1), preload aggregation file + watcher hook point (Task 6 Step 1), keybinding export name/shape (Task 7 Step 1), `worktreeRoot`/`openFile` field names in `MonacoEditor.tsx` (Task 9 Step 6). Each names the command to confirm and how to adapt.
