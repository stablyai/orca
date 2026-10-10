import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const firstGuestPath = '/home/ada/.codex/sessions/first.jsonl'
const secondGuestPath = '/home/ada/.codex/sessions/second.jsonl'
const firstUncPath = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\first.jsonl'
const secondUncPath = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions\\second.jsonl'

const fsMocks = vi.hoisted(() => ({
  access: vi.fn<(path: string) => Promise<void>>()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  access: fsMocks.access
}))

import {
  resetHostReadableTranscriptPathCacheForTests,
  toHostReadableTranscriptPath
} from './host-readable-transcript-path'
import { WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS } from './wsl-transcript-fs-gate'

type AccessControl = {
  resolve: () => void
  reject: (error: Error) => void
}

function wslDeps(): {
  platform: NodeJS.Platform
  listWslHomeDirs: () => Promise<string[]>
} {
  return { platform: 'win32', listWslHomeDirs: async () => [UBUNTU_HOME] }
}

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  fsMocks.access.mockReset()
})

describe('WSL transcript filesystem gate', () => {
  it('serializes distinct probes and releases the permit after failure', async () => {
    const controls: AccessControl[] = []
    fsMocks.access.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          controls.push({ resolve: () => resolve(), reject })
        })
    )

    const first = toHostReadableTranscriptPath(firstGuestPath, wslDeps())
    const second = toHostReadableTranscriptPath(secondGuestPath, wslDeps())

    await vi.waitFor(() => expect(fsMocks.access).toHaveBeenCalledTimes(1))
    controls[0].reject(new Error('stopped distro'))
    await expect(first).resolves.toBeNull()
    await vi.waitFor(() => expect(fsMocks.access).toHaveBeenCalledTimes(2))
    controls[1].resolve()
    await expect(second).resolves.toBe(secondUncPath)
  })

  it('deduplicates identical in-flight probes', async () => {
    let release: (() => void) | undefined
    fsMocks.access.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const first = toHostReadableTranscriptPath(firstGuestPath, wslDeps())
    const duplicate = toHostReadableTranscriptPath(firstGuestPath, wslDeps())

    await vi.waitFor(() => expect(fsMocks.access).toHaveBeenCalledTimes(1))
    release?.()
    await expect(Promise.all([first, duplicate])).resolves.toEqual([firstUncPath, firstUncPath])
  })

  it('does not queue local filesystem work behind a stalled WSL probe', async () => {
    let releaseWsl: (() => void) | undefined
    fsMocks.access.mockImplementation((path) =>
      path === firstUncPath
        ? new Promise<void>((resolve) => {
            releaseWsl = resolve
          })
        : Promise.resolve()
    )

    const wslProbe = toHostReadableTranscriptPath(firstGuestPath, wslDeps())
    await vi.waitFor(() => expect(fsMocks.access).toHaveBeenCalledWith(firstUncPath))

    const localPath = import.meta.filename
    await expect(
      toHostReadableTranscriptPath(localPath, { platform: process.platform })
    ).resolves.toBe(localPath)
    expect(fsMocks.access).toHaveBeenCalledTimes(1)
    releaseWsl?.()
    await expect(wslProbe).resolves.toBe(firstUncPath)
  })

  // Last on purpose: the never-settling Ubuntu probe leaves its gate permit
  // stuck for the rest of this module's lifetime.
  it('falls through to the next distro when a probe exceeds the gate deadline', async () => {
    vi.useFakeTimers()
    const DEBIAN_HOME = '\\\\wsl.localhost\\Debian\\home\\ada'
    const debianUncPath = '\\\\wsl.localhost\\Debian\\home\\ada\\.codex\\sessions\\first.jsonl'
    try {
      fsMocks.access.mockImplementation((path) =>
        path === firstUncPath ? new Promise<void>(() => {}) : Promise.resolve()
      )
      const resolved = toHostReadableTranscriptPath(firstGuestPath, {
        platform: 'win32',
        listWslHomeDirs: async () => [UBUNTU_HOME, DEBIAN_HOME]
      })

      await vi.waitFor(() => expect(fsMocks.access).toHaveBeenCalledWith(firstUncPath))
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_EXACT_TIMEOUT_MS)
      await expect(resolved).resolves.toBe(debianUncPath)
    } finally {
      vi.useRealTimers()
    }
  })
})
