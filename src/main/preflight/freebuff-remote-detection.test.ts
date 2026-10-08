import { afterEach, describe, expect, it, vi } from 'vitest'

const { getActiveMultiplexerMock } = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn()
}))

vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

import { detectRemoteAgents } from './agent-detection'

afterEach(() => vi.resetAllMocks())

describe('Freebuff SSH detection', () => {
  it('asks the execution host to detect Freebuff separately from Codebuff', async () => {
    const request = vi.fn().mockResolvedValue({ agents: ['freebuff'] })
    getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })

    await expect(detectRemoteAgents({ connectionId: 'ssh-freebuff' })).resolves.toEqual([
      'freebuff'
    ])
    expect(getActiveMultiplexerMock).toHaveBeenCalledWith('ssh-freebuff')
    expect(request).toHaveBeenCalledWith('preflight.detectAgents', {
      commands: expect.arrayContaining([
        { id: 'freebuff', cmd: 'freebuff' },
        { id: 'codebuff', cmd: 'codebuff' }
      ])
    })
  })
})
