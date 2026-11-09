import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  CodexHistoryConflictError,
  CodexHistoryNotSharedError,
  prepareLatestCodexThreadCopy
} from './codex-thread-latest-copy'

const DAY = '2024/10/28'
const FILE = (threadId: string): string => `rollout-2024-10-28T05-38-43-${threadId}.jsonl`

let root: string
let homeA: string
let homeB: string
let homeC: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-latest-copy-'))
  homeA = join(root, 'a')
  homeB = join(root, 'b')
  homeC = join(root, 'c')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeRollout(home: string, threadId: string, content: string, compressed = false): string {
  const path = join(home, 'sessions', DAY, FILE(threadId)) + (compressed ? '.zst' : '')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, compressed ? zstdCompressSync(Buffer.from(content)) : content)
  return path
}

function plainIn(home: string, threadId: string): string {
  return join(home, 'sessions', DAY, FILE(threadId))
}

function move(threadId: string, targetHome: string, historyShared = true): Promise<void> {
  return prepareLatestCodexThreadCopy({
    threadId,
    targetHome,
    homes: { homes: [homeA, homeB, homeC], unreadable: false },
    historyShared
  })
}

describe('prepareLatestCodexThreadCopy', () => {
  it('moves the copy that extends the others, and catches an older copy up on return', async () => {
    const threadId = '0192d1a2-3b4c-7d5e-8f60-000000000001'
    // A→B used the copy fallback, then the chat ran two more turns on B.
    writeRollout(homeA, threadId, 'turn-1\n')
    writeRollout(homeB, threadId, 'turn-1\nturn-2\nturn-3\n')

    await move(threadId, homeC)
    expect(readFileSync(plainIn(homeC, threadId), 'utf8')).toBe('turn-1\nturn-2\nturn-3\n')

    await move(threadId, homeA)
    expect(readFileSync(plainIn(homeA, threadId), 'utf8')).toBe('turn-1\nturn-2\nturn-3\n')
  })

  it.skipIf(process.platform === 'win32')(
    'resumes through a history-bridge symlink, keeping one shared copy',
    async () => {
      const threadId = '0192d1a2-3b4c-7d5e-8f60-000000000005'
      const source = writeRollout(homeA, threadId, 'turn-1\n')
      mkdirSync(dirname(plainIn(homeB, threadId)), { recursive: true })
      symlinkSync(source, plainIn(homeB, threadId))

      await move(threadId, homeB)
      expect(lstatSync(plainIn(homeB, threadId)).isSymbolicLink()).toBe(true)
      expect(readFileSync(plainIn(homeB, threadId), 'utf8')).toBe('turn-1\n')
    }
  )

  it('publishes a newer compressed copy as the plain rollout Codex resumes first', async () => {
    const threadId = '0192d1a2-3b4c-7d5e-8f60-000000000002'
    writeRollout(homeA, threadId, 'turn-1\n')
    writeRollout(homeB, threadId, 'turn-1\nturn-2\n', true)

    await move(threadId, homeC)
    expect(readFileSync(plainIn(homeC, threadId), 'utf8')).toBe('turn-1\nturn-2\n')
  })

  it('installs nothing while history sharing is off, but resumes a copy the account already has', async () => {
    const threadId = '0192d1a2-3b4c-7d5e-8f60-000000000003'
    writeRollout(homeA, threadId, 'turn-1\n')

    await expect(move(threadId, homeC, false)).rejects.toBeInstanceOf(CodexHistoryNotSharedError)
    expect(existsSync(plainIn(homeC, threadId))).toBe(false)

    writeRollout(homeC, threadId, 'turn-1\n')
    await expect(move(threadId, homeC, false)).resolves.toBeUndefined()
  })

  it('keeps every copy when two accounts diverged', async () => {
    const threadId = '0192d1a2-3b4c-7d5e-8f60-000000000004'
    writeRollout(homeA, threadId, 'turn-1\nturn-2a\n')
    writeRollout(homeB, threadId, 'turn-1\nturn-2b\n')

    await expect(move(threadId, homeC)).rejects.toBeInstanceOf(CodexHistoryConflictError)
    expect(existsSync(plainIn(homeC, threadId))).toBe(false)
    expect(readFileSync(plainIn(homeA, threadId), 'utf8')).toBe('turn-1\nturn-2a\n')
    expect(readFileSync(plainIn(homeB, threadId), 'utf8')).toBe('turn-1\nturn-2b\n')
  })
})
