import { describe, expect, it } from 'vitest'
import { DaemonRequestRouter } from './daemon-request-router'
import { SessionNotFoundError } from '../protocol/daemon-errors'
import {
  describeTerminalExitCause,
  resolveUnreportedExitCause,
  type TerminalExitCause
} from '../../../shared/terminal/pty/lifecycle/terminal-exit-cause'

type ExitEvent = { payload: { code: number; cause?: TerminalExitCause } }

describe('exit causes the daemon reports', () => {
  it('a write to a session the host lost reads as host loss, not an unconfirmed stop', async () => {
    const events: ExitEvent[] = []
    const options = {
      host: {
        write: (sessionId: string) => {
          throw new SessionNotFoundError(sessionId)
        }
      },
      attachments: { recordInput: () => {}, clearInput: () => {} },
      connections: { get: () => ({ clientId: 'client', streamSocket: {} }) },
      streamDataBatcher: {
        enqueueControlEvent: (_client: string, _session: string, event: ExitEvent) =>
          events.push(event),
        flush: () => {}
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a write reads only these collaborators.
    const router = new DaemonRequestRouter(options as never)
    await expect(
      router.route('client', { id: 'r1', type: 'write', payload: { sessionId: 's1', data: 'x' } })
    ).rejects.toThrow(SessionNotFoundError)
    const [exit] = events
    // As the runtime reads it: a missing cause falls back to the bare code.
    const recorded = exit.payload.cause ?? resolveUnreportedExitCause(exit.payload.code)
    expect(describeTerminalExitCause(recorded)).toBe(
      'Agent process lost; its terminal host or session is gone'
    )
  })

  it('a bare -1 with no producer cause still reads as an unconfirmed stop', () => {
    expect(resolveUnreportedExitCause(-1)).toEqual({ kind: 'unknown', reason: 'stop_unverified' })
  })
})
