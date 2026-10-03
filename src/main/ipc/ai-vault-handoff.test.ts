import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ai-vault/session-handoff-transfer', () => ({
  prepareAiVaultSessionHandoff: mocks.prepare
}))

const { handleAiVaultPrepareSessionHandoff } = await import('./ai-vault-handoff')

const REQUEST = {
  agent: 'claude',
  sessionId: 'abc-123',
  sourceFilePath: '/home/marabel/.claude/projects/orca/session.jsonl'
}

describe('handleAiVaultPrepareSessionHandoff', () => {
  beforeEach(() => {
    mocks.prepare.mockReset()
    mocks.prepare.mockResolvedValue({
      kind: 'transferred',
      transcriptPath: '/home/marabel/.orca/handoffs/claude-abc-123.jsonl',
      byteLength: 42
    })
  })

  it('maps execution hosts to the connections the transfer runs over', async () => {
    await handleAiVaultPrepareSessionHandoff({
      ...REQUEST,
      sourceExecutionHostId: 'local',
      targetExecutionHostId: 'ssh:hetzner'
    })
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sourceConnectionId: null, targetConnectionId: 'hetzner' })
    )
  })

  it('rejects a runtime host, whose files are reachable only inside its worktree', async () => {
    await expect(
      handleAiVaultPrepareSessionHandoff({
        ...REQUEST,
        sourceExecutionHostId: 'runtime:builder',
        targetExecutionHostId: 'local'
      })
    ).resolves.toEqual({ kind: 'failed', reason: 'source-unavailable' })

    await expect(
      handleAiVaultPrepareSessionHandoff({
        ...REQUEST,
        sourceExecutionHostId: 'local',
        targetExecutionHostId: 'runtime:builder'
      })
    ).resolves.toEqual({ kind: 'failed', reason: 'target-unavailable' })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('refuses an incomplete payload without reaching the filesystem', async () => {
    await expect(handleAiVaultPrepareSessionHandoff(undefined)).resolves.toEqual({
      kind: 'failed',
      reason: 'invalid-request'
    })
    await expect(
      handleAiVaultPrepareSessionHandoff({ ...REQUEST, sourceFilePath: '   ' })
    ).resolves.toEqual({ kind: 'failed', reason: 'invalid-request' })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('reports an unsupported transfer as a typed failure', async () => {
    mocks.prepare.mockResolvedValue({ kind: 'unsupported', reason: 'binary-transcript' })
    await expect(
      handleAiVaultPrepareSessionHandoff({ ...REQUEST, targetExecutionHostId: 'ssh:hetzner' })
    ).resolves.toEqual({ kind: 'failed', reason: 'binary-transcript' })
  })

  it('never lets a transfer error escape the IPC boundary', async () => {
    mocks.prepare.mockRejectedValue(new Error('sftp write failed'))
    await expect(
      handleAiVaultPrepareSessionHandoff({ ...REQUEST, targetExecutionHostId: 'ssh:hetzner' })
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'transfer-failed',
      message: 'sftp write failed'
    })
  })
})
