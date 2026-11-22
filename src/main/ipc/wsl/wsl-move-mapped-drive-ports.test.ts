import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { Repo } from '../../../shared/repository/repo-types'

const realpathNative = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, realpath: Object.assign(actual.realpath, { native: realpathNative }) }
})

import {
  clearWslMappedDriveShareCacheForTests,
  readWslMappedDriveShareNow
} from '../../wsl/filesystem/wsl-mapped-drive-share'
import { wslMoveDistroMappedDrivesLastKnown } from './wsl-move-mapped-drive-ports'

const repo = (id: string, path: string): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0
})
const store = {
  getRepos: () => [repo('w', 'W:\\home\\me\\app')],
  getFolderWorkspaces: () => []
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
})
afterEach(() => {
  vi.restoreAllMocks()
  clearWslMappedDriveShareCacheForTests()
  realpathNative.mockReset()
})

describe('the prune check’s mapped drives', () => {
  it('never reads a drive, and counts one with no answer yet as in use', () => {
    expect(wslMoveDistroMappedDrivesLastKnown(store, 'Ubuntu')).toBe('unverifiable')
    expect(realpathNative).not.toHaveBeenCalled()
  })

  it('uses the last answer a preview or add already got', async () => {
    await readWslMappedDriveShareNow('W', {
      platform: 'win32',
      realpathRoot: async () => '\\\\wsl.localhost\\Ubuntu\\',
      now: () => 0,
      timeoutMs: 50
    })
    expect(wslMoveDistroMappedDrivesLastKnown(store, 'Ubuntu')).toEqual([
      { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }
    ])
    expect(wslMoveDistroMappedDrivesLastKnown(store, 'Debian')).toEqual([])
    expect(realpathNative).not.toHaveBeenCalled()
  })
})

describe('the prune check off Windows', () => {
  it('treats drive letters as outside WSL off Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(wslMoveDistroMappedDrivesLastKnown(store, 'Ubuntu')).toEqual([])
  })
})
