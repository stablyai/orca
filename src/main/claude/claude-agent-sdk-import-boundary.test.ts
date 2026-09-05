import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'

/**
 * Keep the agent SDK on the structured-Claude side of the toggle.
 *
 * A user who never leaves the terminal/TUI Claude path must not pay for the SDK:
 * importing it evaluates a package that rewrites
 * `process.env.NoDefaultCurrentDirectoryInExePath`, changing how Windows resolves
 * executables for every later subprocess, and a missing or incompatible install
 * would take normal runtime startup down with it. The ordinary
 * `OrcaRuntimeService` graph reaches the Claude transport module, so only a
 * deferred import keeps that boundary — and only a walk of the real import graph
 * keeps the next static import from quietly restoring it.
 */
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** The Electron main entry: everything the app loads before any session exists. */
const ROOT = 'src/main/index.ts'
/** Proof the walk goes all the way into the Claude transport rather than stopping short. */
const TRANSPORT_MODULE = 'src/main/claude/claude-stream-json-connection.ts'

/**
 * Static, value-carrying specifiers only, read statement by statement so a
 * multi-line `import { ... } from '...'` counts. `import type` is erased before
 * the module ever loads and a bare `import(...)` is the deferral this guards, so
 * neither is an edge the runtime traverses at load time.
 */
const STATEMENT_START = /^\s*(?:import|export)\b/
const TYPE_ONLY = /^\s*(?:import|export)\s+type\b/
const FROM_SPECIFIER = /(?:^|\s)from\s*['"]([^'"]+)['"]/
const SIDE_EFFECT_IMPORT = /^\s*import\s*['"]([^'"]+)['"]/
/** An import statement never spans more lines than its longest specifier list. */
const MAX_STATEMENT_LINES = 60

function readSpecifiers(source: string): string[] {
  const lines = source.split('\n')
  const found: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index] as string
    if (!STATEMENT_START.test(first) || TYPE_ONLY.test(first)) {
      continue
    }
    const sideEffect = SIDE_EFFECT_IMPORT.exec(first)
    if (sideEffect) {
      found.push(sideEffect[1] as string)
      continue
    }
    for (let scan = index; scan < Math.min(lines.length, index + MAX_STATEMENT_LINES); scan += 1) {
      if (scan > index && STATEMENT_START.test(lines[scan] as string)) {
        break
      }
      const specifier = FROM_SPECIFIER.exec(lines[scan] as string)
      if (specifier) {
        found.push(specifier[1] as string)
        break
      }
    }
  }
  return found
}

/** Resolve a relative specifier the way the bundler does; unresolvable means not a module. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

function walkStaticImports(rootFile: string): { visited: Set<string>; sdkImporters: string[] } {
  const visited = new Set<string>()
  const sdkImporters: string[] = []
  const queue = [resolve(REPO_ROOT, rootFile)]
  while (queue.length > 0) {
    const file = queue.pop() as string
    const key = relative(REPO_ROOT, file).split('\\').join('/')
    if (visited.has(key)) {
      continue
    }
    visited.add(key)
    for (const specifier of readSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`)) {
        sdkImporters.push(key)
        continue
      }
      if (!specifier.startsWith('.')) {
        continue
      }
      const target = resolveRelative(file, specifier)
      if (target) {
        queue.push(target)
      }
    }
  }
  return { visited, sdkImporters }
}

describe('claude agent SDK import boundary', () => {
  const walk = walkStaticImports(ROOT)

  it('walks a graph deep enough to reach the Claude transport', () => {
    // Without this the guard passes for the wrong reason the moment the walk breaks.
    expect(walk.visited.size).toBeGreaterThan(500)
    expect([...walk.visited]).toContain(TRANSPORT_MODULE)
  })

  it('never reaches the SDK through a static import from the main entry', () => {
    expect(
      walk.sdkImporters,
      `${SDK_PACKAGE} must stay behind the structured-Claude boundary. Load it with a deferred import inside the session path instead.`
    ).toEqual([])
  })

  it('leaves the Windows executable-search environment alone when the runtime loads', async () => {
    // A vitest file runs in its own fork, so this is a clean process; the ambient
    // value is cleared first because the developer's own shell may carry one.
    delete process.env.NoDefaultCurrentDirectoryInExePath
    await import('../runtime/structured-agent-session-runtime')

    expect(process.env.NoDefaultCurrentDirectoryInExePath).toBeUndefined()
  })

  it('still lets the SDK set it, so the guard above is not measuring nothing', async () => {
    // A separate process, not this fork: the assertion has to be about a first
    // evaluation of the package, which a cached module registry cannot give.
    const { NoDefaultCurrentDirectoryInExePath: _cleared, ...env } = process.env
    const probe = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        `import(${JSON.stringify(SDK_PACKAGE)}).then(() => console.log(String(process.env.NoDefaultCurrentDirectoryInExePath)))`
      ],
      cwd: REPO_ROOT,
      env: env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const observed = await new Promise<string>((settle) => {
      let output = ''
      probe.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk
      })
      probe.once('close', () => settle(output.trim()))
    })

    expect(observed).toBe('1')
  })
})
