import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildHandlerRoutes, dispatch, type HandlerContext } from './dispatch'
import { HANDLER_GROUPS, type HandlerGroup } from './handler-group-manifest'

// Why: dispatch trusts the manifest's eager key lists to route without loading a
// group. These tests are the only thing standing between that trust and a
// silently unreachable command, so they load every group for real.

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
  // scan the directory so a new or forgotten handler file fails here, not in prod.
  it('registers every handler module that exports a handler group', async () => {
    // Why: __dirname works under both Vitest and the CommonJS tsc emit that
    // build:cli type-checks this file against; import.meta.dirname does not.
    const dir = join(__dirname, 'handlers')
    const modules = readdirSync(dir).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')
    )
    const registered = new Set(HANDLER_GROUPS.map((group) => group.name))
    const missing: string[] = []
    for (const file of modules) {
      const name = file.slice(0, -'.ts'.length)
      const exports: Record<string, unknown> = await import(join(dir, file))
      const exportsGroup = Object.keys(exports).some((key) => key.endsWith('_HANDLERS'))
      if (exportsGroup && !registered.has(name)) {
        missing.push(name)
      }
    }
    expect(missing).toEqual([])
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
