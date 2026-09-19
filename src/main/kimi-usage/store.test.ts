import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock, renameMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(),
  renameMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  renameSync: renameMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { initKimiUsagePath, KimiUsageStore } from './store'
import type { Store } from '../persistence'

function createBackingStore(): Pick<Store, 'getRepos' | 'getAllWorktreeMeta'> {
  return { getRepos: () => [], getAllWorktreeMeta: () => ({}) }
}

describe('KimiUsageStore', () => {
  let tempUserData: string

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'orca-kimi-usage-store-'))
    getPathMock.mockReturnValue(tempUserData)
    renameMock.mockReset()
  })

  afterEach(() => {
    rmSync(tempUserData, { recursive: true, force: true })
  })

  it('removes the temporary snapshot when rename fails', async () => {
    initKimiUsagePath()
    renameMock.mockImplementation(() => {
      throw new Error('target locked')
    })
    const store = new KimiUsageStore(createBackingStore())
    const write = store.setEnabled.bind(store)

    await expect(write(true)).rejects.toThrow('target locked')

    const temporaryFiles = readdirSync(tempUserData).filter((name) => name.endsWith('.tmp'))
    expect(temporaryFiles).toEqual([])
    expect(existsSync(join(tempUserData, 'orca-kimi-usage.json'))).toBe(false)
  })
})
