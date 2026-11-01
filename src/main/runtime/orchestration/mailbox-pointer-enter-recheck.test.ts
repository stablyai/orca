import { describe, expect, it, vi } from 'vitest'
import { MAILBOX_POINTER_WRITE_ATTEMPTED } from './db/messages/mailbox-pointer-enter-state'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import { settledWriteStub } from '../../providers/settled-pty-write-stub'

describe('recovered pointer Enter recheck', () => {
  it.each([
    ['fails', async () => false],
    [
      'throws',
      async () => {
        throw new Error('screen read failed')
      }
    ]
  ])(
    'rechecks the composer on the retry after a dialog deferral when it %s',
    async (_name, recheck) => {
      const db = new OrchestrationDb(':memory:')
      const message = db.insertMessage({
        runId: 'run_legacy_local',
        from: 'a',
        to: 'run:run-1',
        subject: 'edited while a dialog was open'
      })
      const ptyId = 'pty-deferred'
      const reservation = { ptyId, processIncarnation: 'inc-deferred' }
      const terminal = {
        ptyId,
        handle: 'term-deferred',
        paneKeys: ['tab-1:leaf-1'],
        lastAgentStatus: 'idle' as const,
        lastAgentStatusObservedLive: true
      }
      const expectedTarget = { terminal, processIncarnation: reservation.processIncarnation }
      const state = new OrchestrationMailboxPointerState()
      const flight = state.beginFlight(ptyId)
      state.setWatermark('run:run-1', 1, ptyId)
      expect(db.stageMailboxPointerEnter([message.id], reservation)).toBe(true)
      expect(db.markMailboxPointerWriteAttempted([message.id], reservation)).toBe(true)
      let dialogOpen = true
      // The user replaces the composer while the dialog holds the Enter.
      const confirmEnter = vi.fn(async () => confirmEnter.mock.calls.length === 1 || recheck())
      const writePty = vi.fn(settledWriteStub())
      const redrive = vi.fn()
      const settle = vi.fn(() => state.settleFlight(ptyId, flight))

      submitOrchestrationMailboxPointer(
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: submit only calls resolve on the owner.
          mailboxOwner: { resolve: () => 'run:run-1' } as never,
          state,
          getDb: () => db,
          resolveSubmitTarget: () => expectedTarget,
          isLeafPtyProvenAbsent: async () => false,
          isPtyAwaitingUserInput: () => dialogOpen,
          writePty,
          settle,
          redrive
        },
        {
          mailboxHandle: 'run:run-1',
          messages: [{ id: message.id, type: 'status' }],
          newestSequence: 1,
          ptyId,
          flight,
          expectedTarget,
          confirmEnter
        }
      )
      await vi.waitFor(() => expect(flight.submitEnter).not.toBeNull())
      dialogOpen = false
      state.takeDeferredEnter(ptyId)?.()

      await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
      expect(confirmEnter).toHaveBeenCalledTimes(2)
      expect(writePty).not.toHaveBeenCalled()
      // Mail parked behind the pointer still drains.
      expect(redrive).toHaveBeenCalledWith('run:run-1', false)
      expect(db.getMessageById(message.id)).toMatchObject({
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
    }
  )

  it('holds Enter for idle when a cold park goes working during the recheck', async () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'cold parked during the recheck'
    })
    const ptyId = 'pty-cold'
    const reservation = { ptyId, processIncarnation: 'inc-cold' }
    const terminal = {
      ptyId,
      handle: 'term-cold',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const expectedTarget = { terminal, processIncarnation: reservation.processIncarnation }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark('run:run-1', 1, ptyId)
    expect(db.stageMailboxPointerEnter([message.id], reservation)).toBe(true)
    expect(db.markMailboxPointerWriteAttempted([message.id], reservation)).toBe(true)
    const confirmEnter = vi.fn(async () => {
      if (confirmEnter.mock.calls.length === 1) {
        // observeAgentWorking on a cold-parked PTY, while the screen read is pending.
        state.deferFlightUntilIdle(ptyId)
      }
      return true
    })
    const writePty = vi.fn(settledWriteStub())

    submitOrchestrationMailboxPointer(
      {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: submit only calls resolve on the owner.
        mailboxOwner: { resolve: () => 'run:run-1' } as never,
        state,
        getDb: () => db,
        resolveSubmitTarget: () => expectedTarget,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle: vi.fn(() => state.settleFlight(ptyId, flight)),
        redrive: vi.fn()
      },
      {
        mailboxHandle: 'run:run-1',
        messages: [{ id: message.id, type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget,
        confirmEnter
      }
    )
    await vi.waitFor(() => expect(flight.submitEnter).not.toBeNull())
    expect(writePty).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(
      MAILBOX_POINTER_WRITE_ATTEMPTED
    )

    // The idle edge releases the held Enter, which rereads the composer first.
    state.takeDeferredEnter(ptyId)?.()
    await vi.waitFor(() => expect(writePty).toHaveBeenCalledWith(ptyId, '\r'))
    expect(confirmEnter).toHaveBeenCalledTimes(2)
  })
})
