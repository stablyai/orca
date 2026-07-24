import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { opendirSyncMock, rmSyncMock } = vi.hoisted(() => ({
  opendirSyncMock: vi.fn(),
  rmSyncMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  opendirSync: opendirSyncMock,
  rmSync: rmSyncMock
}))

import {
  pruneStaleServeSimRuntimes,
  SERVE_SIM_RUNTIME_MAX_PRUNE_ENTRIES
} from './serve-sim-runtime-materializer'

function useEntryNames(names: string[]): {
  closeSync: ReturnType<typeof vi.fn>
  readSync: ReturnType<typeof vi.fn>
} {
  let index = 0
  const directory = {
    closeSync: vi.fn(),
    readSync: vi.fn(() => {
      const name = names[index]
      index += 1
      return name === undefined ? null : { name }
    })
  }
  opendirSyncMock.mockReturnValue(directory)
  return directory
}

describe('serve-sim stale runtime pruning bounds', () => {
  beforeEach(() => {
    opendirSyncMock.mockReset()
    rmSyncMock.mockReset()
  })

  it('processes the exact requested entry limit in stream order', () => {
    const directory = useEntryNames(['old-a', 'keep', 'old-b', 'old-c'])

    pruneStaleServeSimRuntimes('/runtime', 'keep', 3)

    expect(rmSyncMock).toHaveBeenCalledTimes(2)
    expect(rmSyncMock).toHaveBeenNthCalledWith(1, join('/runtime', 'old-a'), {
      recursive: true,
      force: true
    })
    expect(rmSyncMock).toHaveBeenNthCalledWith(2, join('/runtime', 'old-b'), {
      recursive: true,
      force: true
    })
    expect(directory.readSync).toHaveBeenCalledTimes(3)
    expect(directory.closeSync).toHaveBeenCalledOnce()
  })

  it('stops at the production cap without reading or retaining the next entry', () => {
    let nextEntry = 0
    const directory = {
      closeSync: vi.fn(),
      readSync: vi.fn(() => {
        nextEntry += 1
        return { name: `old-${nextEntry}` }
      })
    }
    opendirSyncMock.mockReturnValue(directory)

    pruneStaleServeSimRuntimes('/runtime', 'keep')

    expect(directory.readSync).toHaveBeenCalledTimes(SERVE_SIM_RUNTIME_MAX_PRUNE_ENTRIES)
    expect(rmSyncMock).toHaveBeenCalledTimes(SERVE_SIM_RUNTIME_MAX_PRUNE_ENTRIES)
    expect(directory.closeSync).toHaveBeenCalledOnce()
  })
})
