import { join } from 'node:path'
import type * as NodeFs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const opendirSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  opendirSync: opendirSyncMock
}))

import { discoverNvmVersionBinDirectories } from './nvm-version-directory-discovery'

type FakeEntry = { name: string; directory?: boolean }

function useEntries(entries: FakeEntry[]): { closeSync: ReturnType<typeof vi.fn> } {
  let index = 0
  const closeSync = vi.fn()
  opendirSyncMock.mockReturnValue({
    closeSync,
    readSync: vi.fn(() => {
      const entry = entries[index]
      index += 1
      return entry
        ? {
            name: entry.name,
            isDirectory: () => entry.directory !== false
          }
        : null
    })
  })
  return { closeSync }
}

describe('nvm version directory discovery', () => {
  beforeEach(() => {
    opendirSyncMock.mockReset()
  })

  it('preserves newest-version ordering for an ordinary listing', () => {
    useEntries([
      { name: 'v20.18.0' },
      { name: 'README', directory: false },
      { name: 'v24.2.0' },
      { name: 'v22.14.0' }
    ])

    expect(discoverNvmVersionBinDirectories('/home/alice')).toEqual([
      join('/home/alice', '.nvm', 'versions', 'node', 'v24.2.0', 'bin'),
      join('/home/alice', '.nvm', 'versions', 'node', 'v22.14.0', 'bin'),
      join('/home/alice', '.nvm', 'versions', 'node', 'v20.18.0', 'bin')
    ])
  })

  it('accepts the exact entry and retained-name limits', () => {
    const { closeSync } = useEntries([{ name: 'v20' }, { name: 'v22' }])

    expect(
      discoverNvmVersionBinDirectories('/home/alice', {
        maxEntries: 2,
        maxRetainedNameBytes: 6
      })
    ).toHaveLength(2)
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it('fails closed and closes the stream on the first entry over the count limit', () => {
    const { closeSync } = useEntries([
      { name: 'v20' },
      { name: 'v22' },
      { name: 'v24' },
      { name: 'v26' }
    ])

    expect(
      discoverNvmVersionBinDirectories('/home/alice', {
        maxEntries: 2
      })
    ).toEqual([])
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it('fails closed when retained directory names exceed the byte limit', () => {
    const { closeSync } = useEntries([{ name: 'v20' }, { name: 'v22' }])

    expect(
      discoverNvmVersionBinDirectories('/home/alice', {
        maxRetainedNameBytes: 5
      })
    ).toEqual([])
    expect(closeSync).toHaveBeenCalledOnce()
  })
})
