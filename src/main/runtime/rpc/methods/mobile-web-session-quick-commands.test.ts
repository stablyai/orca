import { describe, expect, it } from 'vitest'
import { MobileWebQuickCommandSnapshotResultSchema } from '../../../../shared/mobile-web/session-quick-command-contract'
import { MOBILE_WEB_SESSION_QUICK_COMMAND_METHODS } from './mobile-web-session-quick-commands'
import { sessionFixture } from './mobile-web-session-test-fixture'

const [read, mutate, launch] = MOBILE_WEB_SESSION_QUICK_COMMAND_METHODS
const command = {
  id: 'command',
  label: 'Run',
  action: 'terminal-command' as const,
  command: 'echo hello',
  appendEnter: true,
  scope: { type: 'global' as const }
}

describe('host session quick commands', () => {
  it('isolates repo commands while folder workspaces retain global commands', async () => {
    const f = sessionFixture()
    f.runtime.getClientTerminalQuickCommands.mockReturnValue([
      command,
      { ...command, id: 'repo-command', scope: { type: 'repo', repoId: 'repo' } }
    ])
    expect(await read.handler(f.params, f.context)).toEqual({
      commands: [command],
      repoId: null,
      totalCount: 2
    })
    f.setSnapshot({ ...f.snapshot, worktree: 'repo::/ssh/path' })
    const result = await read.handler({ ...f.params, worktree: 'id:repo::/ssh/path' }, f.context)
    expect(MobileWebQuickCommandSnapshotResultSchema.parse(result).commands[1]).toMatchObject({
      scope: { type: 'repo', repoId: f.params.workspaceId }
    })
    expect(JSON.stringify(result)).not.toContain('/ssh/path')
  })

  it('refuses mutations outside the current workspace without changing the native settings method', async () => {
    const f = sessionFixture()
    f.runtime.getClientTerminalQuickCommands.mockReturnValue([
      { ...command, scope: { type: 'repo', repoId: 'other' } }
    ])
    await expect(
      mutate.handler({ ...f.params, mutation: { type: 'delete', id: 'command' } }, f.context)
    ).rejects.toThrow('invalid_params')
    expect(f.runtime.updateClientTerminalQuickCommands).not.toHaveBeenCalled()
  })

  it('preserves creation IDs, shell-ready delivery, host selection and caller navigation', async () => {
    const f = sessionFixture()
    f.runtime.getClientTerminalQuickCommands.mockReturnValue([command])
    expect(
      await launch.handler(
        { ...f.params, commandId: command.id, clientMutationId: 'mutation', timeoutMs: 15000 },
        f.context
      )
    ).toMatchObject({ created: true, tabId: 'created', initialInput: null })
    expect(f.runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
      f.params.worktree,
      expect.objectContaining({
        command: 'echo hello',
        startupCommandDelivery: 'shell-ready',
        clientMutationId: 'mutation',
        navigation: 'caller',
        signal: f.controller.signal
      })
    )
  })

  it('inserts non-enter commands and never retries an ambiguous creation result', async () => {
    const f = sessionFixture()
    f.runtime.getClientTerminalQuickCommands.mockReturnValue([{ ...command, appendEnter: false }])
    const params = {
      ...f.params,
      commandId: command.id,
      clientMutationId: 'mutation',
      timeoutMs: 15000
    }
    expect(await launch.handler(params, f.context)).toMatchObject({
      initialInput: { text: command.command, enter: false, successToast: 'Run inserted' }
    })
    f.runtime.createMobileSessionTerminal.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await expect(launch.handler(params, f.context)).rejects.toThrow('lost acknowledgement')
    expect(f.runtime.createMobileSessionTerminal).toHaveBeenCalledTimes(2)
  })

  it('fences canceled agent discovery before mutation', async () => {
    const f = sessionFixture()
    f.runtime.getClientTerminalQuickCommands.mockReturnValue([
      {
        id: 'command',
        label: 'Agent',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: 'hello',
        scope: { type: 'global' }
      }
    ])
    f.runtime.getMobileSessionAgentOptions.mockImplementationOnce(async () => {
      f.controller.abort()
      return ['codex']
    })
    await expect(
      launch.handler(
        { ...f.params, commandId: 'command', clientMutationId: 'mutation', timeoutMs: 15000 },
        f.context
      )
    ).rejects.toThrow('runtime_unavailable')
    expect(f.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('bounds multibyte large responses before crossing the bridge', async () => {
    const f = sessionFixture()
    f.runtime.getClientTerminalQuickCommands.mockReturnValue(
      Array.from({ length: 40 }, (_, index) => ({
        ...command,
        id: String(index),
        command: '界'.repeat(4000)
      }))
    )
    await expect(read.handler(f.params, f.context)).rejects.toThrow('runtime_unavailable')
  })
})
