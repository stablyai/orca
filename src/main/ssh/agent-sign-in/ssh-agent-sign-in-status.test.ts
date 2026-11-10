import { describe, expect, it, vi } from 'vitest'

const exec = vi.fn()
vi.mock('../remote-exec/remote-exec-command', () => ({
  execCommand: (...args: unknown[]) => exec(...args),
  isSshExecTimeout: () => false,
  isSshCommandExitError: (error: unknown) =>
    typeof error === 'object' && error !== null && 'exitCode' in error
}))

const { SshAgentSignInStatus, SSH_AGENT_STATUS_COMMAND } =
  await import('./ssh-agent-sign-in-status')

function transport(connected = true, generation = 1) {
  return {
    exec: vi.fn(),
    usesSystemSshTransport: () => false,
    getConnectGeneration: () => generation,
    connected: () => connected
  }
}

describe('SshAgentSignInStatus', () => {
  it('never runs anything on a disconnected host', async () => {
    exec.mockReset()
    const status = new SshAgentSignInStatus(() => transport(false))
    expect(await status.read('devbox')).toEqual({ ok: false, error: 'disconnected' })
    expect(await new SshAgentSignInStatus(() => null).read('devbox')).toEqual({
      ok: false,
      error: 'disconnected'
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('classifies the CLIs’ own status commands and caches for a minute', async () => {
    exec.mockReset()
    exec.mockImplementation(async (_conn: unknown, command: string) => {
      if (command === SSH_AGENT_STATUS_COMMAND.claude) {
        return '{"loggedIn":true,"authMethod":"claude.ai"}'
      }
      throw Object.assign(new Error('Not logged in'), { exitCode: 1, stdout: '' })
    })
    let now = 0
    const status = new SshAgentSignInStatus(
      () => transport(),
      () => now
    )
    const first = await status.read('devbox')
    expect(first).toEqual({
      ok: true,
      report: {
        checkedAt: 0,
        agents: [
          { agent: 'claude', state: 'signedIn', method: 'cliLogin' },
          { agent: 'codex', state: 'signedOut' }
        ]
      }
    })
    now = 30_000
    await status.read('devbox')
    expect(exec).toHaveBeenCalledTimes(2)
    now = 61_000
    await status.read('devbox')
    expect(exec).toHaveBeenCalledTimes(4)
  })

  it('reports a CLI that isn’t installed', async () => {
    exec.mockReset()
    exec.mockRejectedValue(Object.assign(new Error('not found'), { exitCode: 127, stdout: '' }))
    const result = await new SshAgentSignInStatus(() => transport()).read('devbox')
    expect(result.ok && result.report.agents.map((entry) => entry.state)).toEqual([
      'notInstalled',
      'notInstalled'
    ])
  })
})
