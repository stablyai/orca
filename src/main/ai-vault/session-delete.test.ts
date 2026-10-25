import { join, resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  lstatMock,
  realpathMock,
  trashItemMock,
  tryDeleteWslUncPathMock,
  WslDeleteValidationErrorMock
} = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  trashItemMock: vi.fn(),
  tryDeleteWslUncPathMock: vi.fn(),
  WslDeleteValidationErrorMock: class extends Error {
    constructor(readonly reason: 'path-outside-known-roots' | 'unexpected-target-kind') {
      super(reason)
    }
  }
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  realpath: realpathMock
}))

vi.mock('electron', () => ({
  shell: { trashItem: trashItemMock }
}))

vi.mock('../wsl-unc-delete', () => ({
  tryDeleteWslUncPath: tryDeleteWslUncPathMock,
  WslDeleteValidationError: WslDeleteValidationErrorMock
}))

import { deleteAiVaultSessionFile } from './session-delete'

const HOME = join('/tmp', 'orca-ai-vault-delete-exec-fixture-home')
const GEMINI_ROOT = join(HOME, '.gemini', 'tmp')
const CLAUDE_ROOT = join(HOME, '.claude', 'projects')
const ROVO_ROOT = join(HOME, '.rovodev', 'sessions')

function enoent(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

function baseArgs(filePath: string) {
  return {
    agent: 'gemini' as const,
    filePath,
    executionHostId: 'local' as const,
    rootOptions: { geminiSessionsDir: GEMINI_ROOT }
  }
}

describe('deleteAiVaultSessionFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tryDeleteWslUncPathMock.mockResolvedValue(false)
  })

  it('trashes a regular file whose realpath matches the resolved path', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    lstatMock.mockResolvedValue({ isFile: () => true })
    realpathMock.mockResolvedValue(filePath)
    trashItemMock.mockResolvedValue(undefined)

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({ outcome: 'deleted' })
    expect(trashItemMock).toHaveBeenCalledWith(filePath)
  })

  it('rejects a directory instead of trashing it', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    lstatMock.mockResolvedValue({ isFile: () => false })

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({
      outcome: 'rejected',
      agent: 'gemini',
      reason: 'unexpected-target-kind'
    })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('rejects a regular file whose realpath escapes the known roots', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    const escaped = join(HOME, 'Documents', 'escaped.json')
    lstatMock.mockResolvedValue({ isFile: () => true })
    realpathMock.mockImplementation((p: string) => Promise.resolve(p === filePath ? escaped : p))

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({
      outcome: 'rejected',
      agent: 'gemini',
      reason: 'path-outside-known-roots'
    })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('accepts a session under a symlinked root by realpath-resolving the roots too', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    const realRoot = join('/real', '.gemini', 'tmp')
    const realFile = join(realRoot, 'project-a', 'session-1.json')
    lstatMock.mockResolvedValue({ isFile: () => true })
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(p === GEMINI_ROOT ? realRoot : p === filePath ? realFile : p)
    )
    trashItemMock.mockResolvedValue(undefined)

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({ outcome: 'deleted' })
    expect(trashItemMock).toHaveBeenCalledWith(filePath)
  })

  it('treats ENOENT from lstat as an idempotent success', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    lstatMock.mockRejectedValue(enoent())

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({ outcome: 'deleted' })
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('treats ENOENT from trashItem as an idempotent success (race with an external delete)', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    lstatMock.mockResolvedValue({ isFile: () => true })
    realpathMock.mockResolvedValue(filePath)
    trashItemMock.mockRejectedValue(enoent())

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({ outcome: 'deleted' })
  })

  it('returns a failure result when trashItem throws a non-ENOENT error', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    lstatMock.mockResolvedValue({ isFile: () => true })
    realpathMock.mockResolvedValue(filePath)
    trashItemMock.mockRejectedValue(new Error('permission denied'))

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({ outcome: 'failed', agent: 'gemini', error: 'permission denied' })
  })

  it('short-circuits a rejected validation (unsupported agent) before touching the filesystem', async () => {
    const filePath = join(HOME, '.codex', 'sessions', 'rollout-1.jsonl')

    const result = await deleteAiVaultSessionFile({
      agent: 'codex',
      filePath,
      executionHostId: 'local'
    })

    expect(result).toEqual({ outcome: 'rejected', agent: 'codex', reason: 'unsupported-agent' })
    expect(lstatMock).not.toHaveBeenCalled()
    expect(realpathMock).not.toHaveBeenCalled()
    expect(trashItemMock).not.toHaveBeenCalled()
    expect(tryDeleteWslUncPathMock).not.toHaveBeenCalled()
  })

  it('uses a successful WSL-helper result before local file trash', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    tryDeleteWslUncPathMock.mockResolvedValue(true)

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({ outcome: 'deleted' })
    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(resolve(filePath), {
      recursive: false,
      approvedRoots: [resolve(GEMINI_ROOT)]
    })
    expect(lstatMock).not.toHaveBeenCalled()
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('requests recursive helper removal for a directory-shaped session', async () => {
    // WSL UNC volumes cannot use Trash and may give unreliable 9P stats.
    tryDeleteWslUncPathMock.mockResolvedValue(true)

    const result = await deleteAiVaultSessionFile({
      agent: 'rovo',
      filePath: join(ROVO_ROOT, 'sess-1', 'metadata.json'),
      executionHostId: 'local',
      rootOptions: { rovoSessionsDir: ROVO_ROOT }
    })

    expect(result).toEqual({ outcome: 'deleted' })
    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(resolve(ROVO_ROOT, 'sess-1'), {
      recursive: true,
      approvedRoots: [resolve(ROVO_ROOT)]
    })
    expect(lstatMock).not.toHaveBeenCalled()
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('maps a WSL containment rejection to a delete rejection', async () => {
    const filePath = join(GEMINI_ROOT, 'project-a', 'session-1.json')
    tryDeleteWslUncPathMock.mockRejectedValue(
      new WslDeleteValidationErrorMock('path-outside-known-roots')
    )

    const result = await deleteAiVaultSessionFile(baseArgs(filePath))

    expect(result).toEqual({
      outcome: 'rejected',
      agent: 'gemini',
      reason: 'path-outside-known-roots'
    })
    expect(lstatMock).not.toHaveBeenCalled()
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  describe('directory-shaped agents', () => {
    const claudeArgs = {
      agent: 'claude' as const,
      filePath: join(CLAUDE_ROOT, '-proj', 'sess-1.jsonl'),
      executionHostId: 'local' as const,
      rootOptions: { claudeProjectsDir: CLAUDE_ROOT }
    }

    it('trashes the subagents and session-env dirs before the transcript', async () => {
      lstatMock.mockImplementation((path: string) =>
        Promise.resolve(
          path.endsWith('.jsonl') ? { isFile: () => true } : { isDirectory: () => true }
        )
      )
      realpathMock.mockImplementation((path: string) => Promise.resolve(path))
      trashItemMock.mockResolvedValue(undefined)

      const result = await deleteAiVaultSessionFile(claudeArgs)

      expect(result).toEqual({ outcome: 'deleted' })
      expect(trashItemMock.mock.calls.map(([path]) => path)).toEqual([
        join(CLAUDE_ROOT, '-proj', 'sess-1'),
        join(HOME, '.claude', 'session-env', 'sess-1'),
        claudeArgs.filePath
      ])
    })

    it('still deletes when a companion is absent — most sessions spawn no subagent', async () => {
      lstatMock.mockImplementation((path: string) =>
        path.endsWith('.jsonl') ? Promise.resolve({ isFile: () => true }) : Promise.reject(enoent())
      )
      realpathMock.mockImplementation((path: string) => Promise.resolve(path))
      trashItemMock.mockResolvedValue(undefined)

      const result = await deleteAiVaultSessionFile(claudeArgs)

      expect(result).toEqual({ outcome: 'deleted' })
      expect(trashItemMock.mock.calls.map(([path]) => path)).toEqual([claudeArgs.filePath])
    })

    it('leaves the transcript in place when a companion removal is rejected', async () => {
      lstatMock.mockImplementation((path: string) =>
        Promise.resolve(
          path === join(CLAUDE_ROOT, '-proj', 'sess-1')
            ? { isFile: () => true, isDirectory: () => false }
            : { isFile: () => true, isDirectory: () => true }
        )
      )
      realpathMock.mockImplementation((path: string) => Promise.resolve(path))

      const result = await deleteAiVaultSessionFile(claudeArgs)

      expect(result).toEqual({
        outcome: 'rejected',
        agent: 'claude',
        reason: 'unexpected-target-kind'
      })
      expect(trashItemMock).not.toHaveBeenCalled()
    })

    it("trashes rovo's session directory rather than the metadata file", async () => {
      const sessionDir = join(ROVO_ROOT, 'sess-1')
      lstatMock.mockResolvedValue({ isDirectory: () => true })
      realpathMock.mockImplementation((path: string) => Promise.resolve(path))
      trashItemMock.mockResolvedValue(undefined)

      const result = await deleteAiVaultSessionFile({
        agent: 'rovo',
        filePath: join(sessionDir, 'metadata.json'),
        executionHostId: 'local',
        rootOptions: { rovoSessionsDir: ROVO_ROOT }
      })

      expect(result).toEqual({ outcome: 'deleted' })
      expect(trashItemMock).toHaveBeenCalledWith(sessionDir)
    })
  })
})
