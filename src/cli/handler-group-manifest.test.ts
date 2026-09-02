import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildHandlerRoutes, dispatch, type HandlerContext } from './dispatch'
import { HANDLER_GROUPS, type HandlerGroup } from './handler-group-manifest'

// Why: dispatch trusts the manifest's eager key lists to route without loading a
// group. These tests are the only thing standing between that trust and a
// silently unreachable command, so they load every group for real.

// Why: __dirname works under both Vitest and the CommonJS tsc emit that
// build:cli type-checks this file against; import.meta.dirname does not.
const HANDLERS_DIR = join(__dirname, 'handlers')

// Why: both the plural records and the single-command `*_HANDLER` ones that
// nested modules export get spread into a group, so both must route.
const HANDLER_RECORD_EXPORT = /_HANDLERS?$/

function listHandlerModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listHandlerModules(path)
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

function isHandlerRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'function')
  )
}

describe('handler group manifest', () => {
  it('lists a loadable group for every entry', async () => {
    for (const group of HANDLER_GROUPS) {
      const loaded = await group.load()
      expect(loaded, `${group.name} resolved to a non-record`).toBeTypeOf('object')
    }
  })

  it('matches each group export key-for-key', async () => {
    const drift: string[] = []
    for (const group of HANDLER_GROUPS) {
      const actual = Object.keys(await group.load()).sort()
      const declared = [...group.keys].sort()
      if (JSON.stringify(actual) !== JSON.stringify(declared)) {
        drift.push(
          `${group.name}: manifest ${JSON.stringify(declared)} !== export ${JSON.stringify(actual)}`
        )
      }
    }
    expect(drift).toEqual([])
  })

  it('exposes every declared key as a callable handler', async () => {
    const notCallable: string[] = []
    for (const group of HANDLER_GROUPS) {
      const loaded = await group.load()
      for (const key of group.keys) {
        if (typeof loaded[key] !== 'function') {
          notCallable.push(`${group.name}/${key}`)
        }
      }
    }
    expect(notCallable).toEqual([])
  })

  it('reaches every group through dispatch routing', () => {
    const routes = buildHandlerRoutes(HANDLER_GROUPS)
    const reached = new Set([...routes.values()].map((group) => group.name))
    const unreachable = HANDLER_GROUPS.filter((group) => !reached.has(group.name)).map(
      (group) => group.name
    )
    expect(unreachable).toEqual([])
  })

  // Why: dropping a group from the manifest silently unregisters its commands —
  // walk the tree so a new or forgotten handler file fails here, not in prod.
  // Nested modules are spread into a parent group rather than registered under
  // their own name, so routability, not file name, is the invariant that holds.
  it('routes every command exported by a handler module', async () => {
    const routes = buildHandlerRoutes(HANDLER_GROUPS)
    const unroutable: string[] = []
    for (const file of listHandlerModules(HANDLERS_DIR)) {
      const exports: Record<string, unknown> = await import(file)
      for (const [name, value] of Object.entries(exports)) {
        if (!HANDLER_RECORD_EXPORT.test(name) || !isHandlerRecord(value)) {
          continue
        }
        for (const key of Object.keys(value)) {
          if (!routes.has(key)) {
            unroutable.push(`${relative(HANDLERS_DIR, file)} ${name}: ${key}`)
          }
        }
      }
    }
    expect(unroutable).toEqual([])
  })

  it('finds the modules it is meant to guard', () => {
    // Why: a walk that missed the tree would make the guard above vacuously pass.
    const modules = listHandlerModules(HANDLERS_DIR)
    expect(modules.length).toBeGreaterThanOrEqual(40)
    expect(
      modules.filter((file) => relative(HANDLERS_DIR, file).includes(sep)).length
    ).toBeGreaterThanOrEqual(7)
  })
})

describe('duplicate command keys', () => {
  const group = (name: string, keys: string[]): HandlerGroup => ({
    name,
    keys,
    load: async () => ({})
  })

  it('rejects the same key claimed by two groups', () => {
    expect(() =>
      buildHandlerRoutes([group('alpha', ['ship it']), group('beta', ['ship it'])])
    ).toThrow('Duplicate CLI handler registration for "ship it" (alpha and beta)')
  })

  it('rejects a key duplicated inside one group list', () => {
    expect(() => buildHandlerRoutes([group('alpha', ['ship it', 'ship it'])])).toThrow(
      'Duplicate CLI handler registration for "ship it"'
    )
  })

  it('accepts distinct keys across groups', () => {
    const routes = buildHandlerRoutes([group('alpha', ['a']), group('beta', ['b'])])
    expect([...routes.keys()]).toEqual(['a', 'b'])
  })

  it('holds for the live manifest', () => {
    expect(() => buildHandlerRoutes(HANDLER_GROUPS)).not.toThrow()
  })
})

describe('dispatch errors', () => {
  const ctx = {
    flags: new Map(),
    cwd: '/tmp',
    json: false
  } as unknown as HandlerContext

  it('reports an unknown command with the joined path', async () => {
    await expect(dispatch(['not', 'a', 'command'], ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown command: not a command'
    })
  })
})
