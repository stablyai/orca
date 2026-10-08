import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

// Mail parked on a chat is retried on the edges that can change its verdict, never on every
// streamed frame: each retry reads the whole journal.
describe('structured session status edges for parked mail', () => {
  function runtimeWithRedriveSpy() {
    const runtime = new OrcaRuntimeService()
    const redrive = vi
      .spyOn(runtime, 'notifyStructuredSessionJournalActivity')
      .mockImplementation(() => {})
    return { runtime, redrive }
  }

  it('does not retry on the summaries a running turn streams', () => {
    const { runtime, redrive } = runtimeWithRedriveSpy()
    for (let frame = 0; frame < 20; frame += 1) {
      runtime.onStructuredSessionStatusForMail(
        { sessionId: 's1', status: 'working' },
        { previousStatus: 'working' }
      )
    }
    runtime.onStructuredSessionStatusForMail(
      { sessionId: 's1', status: 'attention' },
      { previousStatus: 'working' }
    )
    expect(redrive).not.toHaveBeenCalled()
  })

  it('retries once when an answered prompt lets the turn run on', () => {
    const { runtime, redrive } = runtimeWithRedriveSpy()
    runtime.onStructuredSessionStatusForMail(
      { sessionId: 's1', status: 'working' },
      { previousStatus: 'attention' }
    )
    expect(redrive).toHaveBeenCalledTimes(1)
    expect(redrive).toHaveBeenCalledWith('s1')
  })
})
