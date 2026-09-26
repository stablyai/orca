import { beforeEach, expect, it, vi } from 'vitest'
import { readAiVaultFirstUserPrompt } from './session-first-user-prompt-read'

const reader = vi.hoisted(() => ({ v1: vi.fn(), v2: vi.fn() }))
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', () => ({
  parseOpenCodeSqliteSessionViaWorker: reader.v1,
  parseOpenCode2SqliteSessionViaWorker: reader.v2
}))

beforeEach(() => {
  reader.v1.mockReset().mockResolvedValue({ firstUserPrompt: 'full first prompt' })
  reader.v2.mockReset().mockResolvedValue({ firstUserPrompt: 'full second-schema prompt' })
})

it('asks the host reader for the full prompt instead of opening SQLite in the calling process', async () => {
  expect(await readAiVaultFirstUserPrompt({
    agent: 'opencode', filePath: '/home/me/opencode.db#session-1'
  })).toEqual({ prompt: 'full first prompt' })
  expect(reader.v1).toHaveBeenCalledWith({
    dbPath: '/home/me/opencode.db', sessionId: 'session-1', platform: process.platform,
    fullFirstUserPrompt: true
  })
})

it('keeps a WSL database address intact for host routing', async () => {
  const dbPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\opencode.db'
  expect(await readAiVaultFirstUserPrompt({
    agent: 'opencode', filePath: dbPath, sessionId: 'session-1'
  })).toEqual({ prompt: 'full first prompt' })
  expect(reader.v1).toHaveBeenCalledWith(expect.objectContaining({
    dbPath, sessionId: 'session-1', fullFirstUserPrompt: true
  }))
})

it('supports the v2 schema through the same full-prompt worker contract', async () => {
  expect(await readAiVaultFirstUserPrompt({
    agent: 'opencode2', filePath: '/home/me/opencode.db', sessionId: 'channel/session-1'
  })).toEqual({ prompt: 'full second-schema prompt' })
  expect(reader.v2).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'channel/session-1', fullFirstUserPrompt: true
  }))
  expect(reader.v1).not.toHaveBeenCalled()
})

it('does not substitute local history for a remote session', async () => {
  expect(await readAiVaultFirstUserPrompt({
    agent: 'opencode', filePath: '/home/me/opencode.db', sessionId: 'session-1',
    executionHostId: 'ssh:host'
  })).toEqual({ prompt: null })
  expect(reader.v1).not.toHaveBeenCalled()
})

it('degrades a failed guest read to an unavailable prompt', async () => {
  reader.v1.mockRejectedValue(new Error('guest stopped'))
  expect(await readAiVaultFirstUserPrompt({
    agent: 'opencode', filePath: '/home/me/opencode.db', sessionId: 'session-1'
  })).toEqual({ prompt: null })
})
