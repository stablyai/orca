import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UNC_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.claude\\projects\\p\\stalled.jsonl'
const STALLED_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LOCAL_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

const mocks = vi.hoisted(() => ({ lstat: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFsPromisesModule>()
  return {
    ...original,
    // Only the WSL request is faked; the local sibling reads a real temp file.
    lstat: (path: string, ...rest: unknown[]) =>
      path.startsWith('\\\\')
        ? mocks.lstat(path)
        : (original.lstat as (...args: unknown[]) => unknown)(path, ...rest)
  }
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS
} from '../native-chat/wsl-transcript-fs-gate'

let releaseStall: (() => void) | undefined
let tempRoot: string | undefined

function stalls(): Promise<never> {
  return new Promise<never>((resolve) => {
    releaseStall = () => resolve(undefined as never)
  })
}

function userRecord(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: new Date(1740000000000).toISOString(),
    cwd: '/repo/app',
    gitBranch: 'main',
    message: { role: 'user', content: text }
  })
}

beforeEach(async () => {
  resetWslTranscriptFsGateForTests()
  resetSessionParseCacheForTests()
  mocks.lstat.mockReset()
  releaseStall = undefined
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-title-stall-'))
})

afterEach(async () => {
  releaseStall?.()
  releaseStall = undefined
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

describe('AI Vault session titles with a stalled WSL transcript lstat', () => {
  it('drops only the stalled request and still returns the rest of the batch', async () => {
    const localPath = join(tempRoot!, `${LOCAL_SESSION_ID}.jsonl`)
    await writeFile(localPath, `${userRecord(LOCAL_SESSION_ID, 'hello world')}\n`)
    mocks.lstat.mockImplementation(stalls)
    vi.useFakeTimers()

    const pending = readAiVaultSessionTitlesFromFiles([
      { agent: 'claude', sessionId: STALLED_SESSION_ID, transcriptPath: UNC_PATH },
      { agent: 'claude', sessionId: LOCAL_SESSION_ID, transcriptPath: localPath }
    ])
    await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)

    const { titles } = await pending
    expect(titles).toEqual([{ agent: 'claude', sessionId: LOCAL_SESSION_ID, title: 'hello world' }])
  })
})
