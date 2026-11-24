import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  requireInstalledStructuredHost: vi.fn(),
  host: {
    sessionAgent: vi.fn<(sessionId: string) => string | undefined>(),
    commandDetail: vi.fn<(sessionId: string, tuple: unknown) => string | null>()
  }
}))
vi.mock('../creation/structured-agent-session-gate', () => ({
  requireInstalledStructuredHost: hoisted.requireInstalledStructuredHost
}))

import { STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHODS } from './structured-agent-session-background-command'
import { BackgroundCommandParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'

const [method] = STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHODS
const params = {
  sessionId: 'session-1',
  childWorkId: 'child-1',
  invocation: { invocationId: 'run-1', generation: 2 }
}

beforeEach(() => {
  hoisted.requireInstalledStructuredHost.mockReset()
  hoisted.requireInstalledStructuredHost.mockResolvedValue(hoisted.host)
  hoisted.host.sessionAgent.mockReturnValue('codex')
  hoisted.host.commandDetail.mockReturnValue('make all')
})

describe('agentSession.backgroundCommand', () => {
  it('reads the exact tuple through the default membership gate', async () => {
    await expect(method!.handler(params, { clientKind: undefined } as never)).resolves.toEqual({
      command: 'make all'
    })
    expect(hoisted.requireInstalledStructuredHost).toHaveBeenCalledWith(
      expect.anything(),
      'session-1'
    )
    expect(hoisted.host.commandDetail).toHaveBeenCalledWith('session-1', {
      childWorkId: 'child-1',
      invocationId: 'run-1',
      generation: 2
    })
  })

  it('denies every phone before touching the host', async () => {
    await expect(method!.handler(params, { clientKind: 'mobile' } as never)).rejects.toThrow()
    expect(hoisted.requireInstalledStructuredHost).not.toHaveBeenCalled()
  })

  it('answers null for a non-Codex session and passes on a gate refusal', async () => {
    hoisted.host.sessionAgent.mockReturnValue('claude')
    await expect(method!.handler(params, {} as never)).resolves.toEqual({ command: null })
    hoisted.requireInstalledStructuredHost.mockRejectedValue(new Error('no longer a member'))
    await expect(method!.handler(params, {} as never)).rejects.toThrow('no longer a member')
  })

  it('takes strictly bounded params only', () => {
    expect(BackgroundCommandParams.safeParse(params).success).toBe(true)
    expect(BackgroundCommandParams.safeParse({ ...params, extra: 1 }).success).toBe(false)
    expect(
      BackgroundCommandParams.safeParse({
        ...params,
        invocation: { invocationId: 'r', generation: 0 }
      }).success
    ).toBe(false)
    expect(
      BackgroundCommandParams.safeParse({ ...params, childWorkId: 'x'.repeat(257) }).success
    ).toBe(false)
  })
})
