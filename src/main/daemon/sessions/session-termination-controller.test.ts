import { describe, expect, it } from 'vitest'
import { SessionTerminationController } from './session-termination-controller'

describe('SessionTerminationController producer pause', () => {
  it('lets the producer pause again once every force-kill attempt is refused', async () => {
    const reasons: string[] = []
    const controller = new SessionTerminationController({
      sessionId: 'tui',
      subprocess: {
        kill: () => {},
        forceKill: () => Promise.reject(new Error('EPERM')),
        signal: () => {},
        dispose: () => {}
      },
      isExited: () => false,
      releaseProducerPause: ({ reason }) => reasons.push(reason)
    })
    await expect(controller.forceKillAndWaitForExit(10)).rejects.toThrow('EPERM')
    expect(reasons).toEqual(['terminating', 'released'])
    expect(controller.isTerminating).toBe(true)
    expect(controller.streamPauseAnswer(true)).toBe(true)
  })
})
