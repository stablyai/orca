import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dirent } from 'node:fs'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const WSL_DATA_DIR = `${WSL_HOME}/.local/share/opencode`

const mocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  readdir: mocks.readdir,
  stat: mocks.stat
}))

// The SQLite leg spawns a real worker thread, which fake timers cannot drive.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', () => ({
  listOpenCodeSqliteSessionsViaWorker: async () => []
}))

import { opencodeDiscoveries } from './session-scanner-opencode-sources'
import { WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS } from '../native-chat/wsl-transcript-fs-gate'

let releaseStall: (() => void) | undefined

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function stalls(): Promise<never> {
  return new Promise<never>((resolve) => {
    releaseStall = () => resolve(undefined as never)
  })
}

beforeEach(() => {
  mocks.readdir.mockReset()
  mocks.stat.mockReset()
  releaseStall = undefined
  vi.useFakeTimers()
})

afterEach(async () => {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

describe('OpenCode source discovery with a stalled WSL data directory', () => {
  it('reports the stalled home as an issue and still resolves every discovery', async () => {
    mocks.readdir.mockImplementation((dir: string) =>
      dir === WSL_DATA_DIR ? stalls() : Promise.resolve([] as Dirent[])
    )
    const issues: AiVaultScanIssue[] = []
    const discoveries = Promise.all(
      opencodeDiscoveries(
        { opencodeStorageDir: '/home/ada/.local/share/opencode/storage' },
        [WSL_HOME],
        10,
        issues
      )
    )
    // Two deadlines: the data-dir probe, then the storage scan that queued
    // behind it before the route was flagged stuck.
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS * 2 + 2)

    // Zero databases for that home is the degraded answer; without the issue it
    // would be indistinguishable from "OpenCode was never installed there".
    const resolved = await discoveries
    expect(resolved).toHaveLength(2)
    expect(resolved.every((discovery) => discovery.files.length === 0)).toBe(true)
    expect(issues.some((issue) => issue.path === WSL_DATA_DIR)).toBe(true)
    expect(issues.every((issue) => issue.agent === 'opencode')).toBe(true)
  })

  it('reports a refused primary data directory instead of scanning clean', async () => {
    const previousXdg = process.env.XDG_DATA_HOME
    const previousDb = process.env.OPENCODE_DB
    process.env.XDG_DATA_HOME = WSL_HOME
    delete process.env.OPENCODE_DB
    try {
      mocks.readdir.mockImplementation(stalls)
      const issues: AiVaultScanIssue[] = []
      const discoveries = Promise.all(opencodeDiscoveries({}, [], 10, issues))
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS * 2 + 2)

      // The primary source is the one per-root containment cannot reach, so a
      // silent [] here reads as "no OpenCode sessions" on a clean scan.
      await expect(discoveries).resolves.toHaveLength(1)
      expect(
        issues.some((issue) => issue.agent === 'opencode' && issue.path === `${WSL_HOME}/opencode`)
      ).toBe(true)
    } finally {
      restoreEnv('XDG_DATA_HOME', previousXdg)
      restoreEnv('OPENCODE_DB', previousDb)
    }
  })
})
