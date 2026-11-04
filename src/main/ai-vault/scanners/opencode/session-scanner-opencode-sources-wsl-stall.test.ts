import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'

const mocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  readdir: mocks.readdir,
  stat: mocks.stat
}))

// The SQLite leg spawns a real worker thread, which fake timers cannot drive.
vi.mock('./reader-transport/session-scanner-opencode-sqlite-worker-spawn', () => ({
  listOpenCodeSqliteSessionsViaWorker: async () => [],
  listOpenCode2SqliteSessionsViaWorker: async () => []
}))

import { opencodeDiscoveries } from './session-scanner-opencode-sources'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS
} from '../../../native-chat/wsl-transcript-fs-gate'

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
  resetWslTranscriptFsGateForTests()
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

      await expect(discoveries).resolves.toHaveLength(2)
      expect(
        issues.some((issue) => issue.agent === 'opencode' && issue.path === `${WSL_HOME}/opencode`)
      ).toBe(true)
    } finally {
      restoreEnv('XDG_DATA_HOME', previousXdg)
      restoreEnv('OPENCODE_DB', previousDb)
    }
  })
})
