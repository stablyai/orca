import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  prepareRouteSnapshot,
  withRouteSnapshot
} from '../mobile-web/check-entry/run-mobile-web-app-checks.mjs'

const collect = async (entries) => ({
  modules: [...entries, 'node_modules/react/index.js'],
  local: entries
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
