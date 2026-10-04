import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readRouteSnapshot } from './mobile-web-app-route-snapshot.mjs'
import {
  prepareRouteSnapshot,
  withPreparedRouteSnapshot,
  withRouteSnapshot
} from './run-mobile-web-app-checks.mjs'
import { PAGE_ROUTE_MODULES } from './mobile-web-app-page-route-modules.mjs'

const collect = async (entries) => ({
  modules: [...entries, 'node_modules/react/index.js'],
  local: entries
})

it('collects each real route once and shares isolated results for one invocation', async () => {
  const collected = []
  let snapshotFile
  await withRouteSnapshot(
    async (file) => {
      snapshotFile = file
      for (const route of PAGE_ROUTE_MODULES.values()) {
        const expected = await collect(['app/_layout', 'app/h/_layout', route])
        expect(readRouteSnapshot(route, file)).toEqual(expected)
        readRouteSnapshot(route, file).local.length = 0
        expect(readRouteSnapshot(route, file)).toEqual(expected)
      }
      expect(readRouteSnapshot('new-route', file)).toBeUndefined()
    },
    async (entries) => {
      collected.push(entries[2])
      return collect(entries)
    }
  )
  expect(collected).toEqual([...new Set(PAGE_ROUTE_MODULES.values())])
  expect(existsSync(snapshotFile)).toBe(false)
})

it('removes the snapshot after a failed suite and propagates the failure', async () => {
  let snapshotFile
  await expect(
    withRouteSnapshot(async (file) => {
      snapshotFile = file
      throw new Error('failed assertion')
    }, collect)
  ).rejects.toThrow('failed assertion')
  expect(existsSync(snapshotFile)).toBe(false)
})

it('never launches tests after dependency collection fails', async () => {
  await expect(
    withRouteSnapshot(
      () => {
        throw new Error('must not launch')
      },
      async () => {
        throw new Error('unresolved import')
      }
    )
  ).rejects.toThrow('unresolved import')
})

describe('snapshot validation', () => {
  it('leaves ordinary builds and scratch routes uncached', () => {
    expect(readRouteSnapshot('any', '')).toBeUndefined()
  })
  it.each(['{}', '{', '{"version":1,"routes":[{"route":"bad","closure":{}}]}'])(
    'rejects damaged snapshots: %s',
    async (bytes) => {
      await withRouteSnapshot(async (file) => {
        writeFileSync(file, bytes)
        expect(() => readRouteSnapshot('bad', file)).toThrow()
      }, collect)
    }
  )
})

it('consumes a separately prepared snapshot and removes it after success', async () => {
  await withRouteSnapshot(async (file) => {
    const result = await withPreparedRouteSnapshot(file, async (prepared) => {
      expect(prepared).toBe(file)
      return 'verified'
    })
    expect(result).toBe('verified')
    expect(existsSync(file)).toBe(false)
  }, collect)
})

it('rejects incomplete prepared snapshots before launching tests', async () => {
  await withRouteSnapshot(async (file) => {
    writeFileSync(file, JSON.stringify({ version: 1, routes: [] }))
    let launched = false
    await expect(
      withPreparedRouteSnapshot(file, async () => {
        launched = true
      })
    ).rejects.toThrow('missing')
    expect(launched).toBe(false)
    expect(existsSync(file)).toBe(false)
  }, collect)
})

it('removes previous evidence before a failed preparation', async () => {
  await withRouteSnapshot(async (file) => {
    await expect(
      prepareRouteSnapshot(file, async () => {
        throw new Error('unresolved import')
      })
    ).rejects.toThrow('unresolved import')
    expect(existsSync(file)).toBe(false)
  }, collect)
})
