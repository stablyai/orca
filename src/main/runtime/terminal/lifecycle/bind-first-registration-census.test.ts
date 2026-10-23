// Bind-first census (L80): every production site that registers a terminal with the runtime runs
// after the write that binds its pane, so main's layout answers which pane holds it from then on.
// A new registration site fails here until it is listed with the binding write that precedes it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../../../..')

/** Create path → the registration site and the binding write that precedes it in the same function. */
const CREATE_PATHS = [
  {
    // Both start lanes (window spawn, agent launch included, and runtime spawn) commit here.
    path: 'spawn commit, a new terminal',
    file: 'src/main/ipc/pty/spawn-commit-assembly.ts',
    bindsWith: 'savePtySpawnPaneBinding('
  },
  {
    // An adoption attaches to a live owner whose pane already binds it; nothing is written.
    path: 'spawn commit, an adopted live owner',
    file: 'src/main/ipc/pty/spawn-commit-assembly.ts',
    bindsWith: 'adopted.owner'
  },
  {
    path: 'pane adoption of a live session',
    file: 'src/main/ipc/pty/pane/complete-pane-adoption.ts',
    bindsWith: 'persistAdmittedStablePaneBinding('
  },
  {
    path: 'runtime create: CLI terminal.create, orchestration and federated workers, provisioning',
    file: 'src/main/runtime/terminal/launch/terminal-create.ts',
    bindsWith: 'spawnInAdmittedPane('
  },
  {
    path: 'runtime-owned mobile create and restored-pane start',
    file: 'src/main/runtime/terminal/launch/mobile-terminal-owned-create.ts',
    bindsWith: 'createTerminal('
  },
  {
    path: 'CLI split of a terminal',
    file: 'src/main/runtime/terminal/launch/terminal-split-surface.ts',
    bindsWith: 'spawnInAdmittedPane('
  },
  {
    path: 'split main starts in its own layout',
    file: 'src/main/runtime/terminal/launch/terminal-split-in-main.ts',
    bindsWith: 'spawnInAdmittedPane('
  }
] as const

/** The registration call itself, not a site that registers a terminal. */
const DEFINITION = 'src/main/ipc/pty/pane/spawn-registration.ts'

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression
  if (ts.isIdentifier(callee)) {
    return callee.text
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : null
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return current
    }
  }
  return null
}

/** Each runtime registration in the file, with its function's source before the call. */
function registrations(file: string): { line: number; textBefore: string }[] {
  const text = readFileSync(path.join(ROOT, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: { line: number; textBefore: string }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (
        name === 'registerPersistedPtySpawn' ||
        (name === 'registerPty' && ts.isPropertyAccessExpression(node.expression))
      ) {
        const fn = enclosingFunction(node)
        found.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          textBefore: fn ? text.slice(fn.getStart(), node.getStart()) : ''
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function productionFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of ts.sys.readDirectory(current, ['.ts'], undefined, undefined)) {
      const relative = path.relative(ROOT, entry).split(path.sep).join('/')
      if (
        !/\.(test|spec)\.ts$/.test(relative) &&
        !/(fixture|harness)/.test(relative) &&
        relative !== DEFINITION
      ) {
        out.push(relative)
      }
    }
  }
  walk(path.join(ROOT, dir))
  return out
}

describe('bind-first registration census (L80)', () => {
  it('lists every runtime registration site with the binding write before it', () => {
    const listed = new Set<string>(CREATE_PATHS.map((entry) => entry.file))
    const unlisted = productionFiles('src/main').filter(
      (file) => !listed.has(file) && registrations(file).length > 0
    )
    expect(unlisted).toEqual([])
    for (const file of listed) {
      const binds = CREATE_PATHS.filter((entry) => entry.file === file).map((e) => e.bindsWith)
      const sites = registrations(file)
      expect(sites.length, file).toBeGreaterThan(0)
      // Every registration in the file runs after one of its paths' binding writes, in its function.
      const unbound = sites.filter((site) => !binds.some((bind) => site.textBefore.includes(bind)))
      expect(
        unbound.map((site) => `${file}:${site.line}`),
        `registers before binding (${binds.join(', ')})`
      ).toEqual([])
    }
  })
})
