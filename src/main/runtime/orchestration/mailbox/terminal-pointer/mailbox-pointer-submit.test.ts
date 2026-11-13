import { describe, expect, it, vi } from 'vitest'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import {
  settledWriteStub,
  stubWriteSettlement
} from '../../../../providers/testing/settled-pty-write-stub'
import type { WriteSettlement } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

describe('orchestration mailbox pointer submit', () => {
  it('does not settle a replacement reservation after an old Enter write resolves', async () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'staged'
    })
    const ptyId = 'pty-reused'
    const oldReservation = { ptyId, processIncarnation: 'inc-old' }
    const replacementReservation = { ptyId, processIncarnation: 'inc-new' }
    const terminal = {
      ptyId,
      handle: 'term-reused',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const expectedTarget = {
      terminal,
      processIncarnation: oldReservation.processIncarnation
    }
    const state = new OrchestrationMailboxPointerState()
    const oldFlight = state.beginFlight(ptyId)
    state.setWatermark('run:run-1', 1, ptyId)
    expect(db.stageMailboxPointerEnter([message.id], oldReservation)).toBe(true)
    expect(db.markMailboxPointerWriteAttempted([message.id], oldReservation)).toBe(true)
    let resolveWrite!: (settlement: WriteSettlement) => void
    const writePty = vi.fn(
      () => new Promise<WriteSettlement>((resolve) => (resolveWrite = resolve))
    )
    const settle = vi.fn()

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => 'run:run-1' } as never,
        state,
        getDb: () => db,
        resolveSubmitTarget: () => expectedTarget,
        readForeground: async () => 'unknown',
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        mailboxHandle: 'run:run-1',
        messages: [{ id: message.id, type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight: oldFlight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(writePty).toHaveBeenCalledOnce())
    state.retirePty(ptyId)
    state.beginFlight(ptyId)
    db.releaseMailboxPointerEnter([message.id], oldReservation, [MAILBOX_POINTER_ENTER_ATTEMPTED])
    expect(db.stageMailboxPointerEnter([message.id], replacementReservation)).toBe(true)
    expect(db.markMailboxPointerWriteAttempted([message.id], replacementReservation)).toBe(true)
    resolveWrite(stubWriteSettlement(true))

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED,
      pointer_pty_id: ptyId,
      pointer_process_incarnation: replacementReservation.processIncarnation
    })
    db.close()
  })

  it('does not overwrite a message already reserved by another pointer flight', () => {
    const db = new OrchestrationDb(':memory:')
    const first = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'first'
    })
    const second = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'second'
    })
    const original = { ptyId: 'pty-a', processIncarnation: 'inc-a' }
    const replacement = { ptyId: 'pty-b', processIncarnation: 'inc-b' }

    expect(db.stageMailboxPointerEnter([first.id], original)).toBe(true)
    expect(db.stageMailboxPointerEnter([first.id, second.id], replacement)).toBe(false)
    expect(db.getMessageById(first.id)).toMatchObject({
      pointer_enter_pending: 1,
      pointer_pty_id: original.ptyId,
      pointer_process_incarnation: original.processIncarnation
    })
    expect(db.getMessageById(second.id)).toMatchObject({
      pointer_enter_pending: 0,
      pointer_pty_id: null,
      pointer_process_incarnation: null
    })
    db.close()
  })

  describe('a pointer whose mail a check read before Enter', () => {
    function submitAfterRead(
      options: {
        absent?: boolean
        replaced?: boolean
        shellInFront?: boolean
        dialogOpen?: boolean
      } = {}
    ) {
      const db = new OrchestrationDb(':memory:')
      const message = db.insertMessage({
        runId: 'run_legacy_local',
        from: 'a',
        to: 'run:run-1',
        subject: 'read by check'
      })
      const ptyId = 'pty-read'
      const reservation = { ptyId, processIncarnation: 'inc-read' }
      const terminal = {
        ptyId,
        handle: 'term-read',
        paneKeys: ['tab-1:leaf-1'],
        lastAgentStatus: options.shellInFront ? null : ('idle' as const),
        lastAgentStatusObservedLive: !options.shellInFront
      }
      const expectedTarget = { terminal, processIncarnation: reservation.processIncarnation }
      const state = new OrchestrationMailboxPointerState()
      const flight = state.beginFlight(ptyId)
      state.setWatermark('run:run-1', 1, ptyId)
      expect(db.stageMailboxPointerEnter([message.id], reservation)).toBe(true)
      expect(db.markMailboxPointerWriteAttempted([message.id], reservation)).toBe(true)
      db.markAsRead([message.id])
      const writePty = vi.fn(settledWriteStub())
      const settle = vi.fn(() => state.settleFlight(ptyId, flight))
      submitOrchestrationMailboxPointer(
        {
          mailboxOwner: { resolve: () => 'run:run-1' } as never,
          state,
          getDb: () => db,
          resolveSubmitTarget: () =>
            options.replaced ? { terminal, processIncarnation: 'inc-replaced' } : expectedTarget,
          readForeground: async () => 'unknown',
          isLeafPtyProvenAbsent: async () => options.absent ?? false,
          isPtyAwaitingUserInput: () => options.dialogOpen ?? false,
          writePty,
          settle,
          redrive: vi.fn()
        },
        {
          mailboxHandle: 'run:run-1',
          messages: [{ id: message.id, type: 'status' }],
          newestSequence: 1,
          ptyId,
          flight,
          expectedTarget
        }
      )
      return { db, message, writePty, settle, flight }
    }

    it('still sends exactly one Enter and records the pointer as delivered', async () => {
      const { db, message, writePty, settle } = submitAfterRead()

      await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
      expect(writePty.mock.calls).toEqual([['pty-read', '\r']])
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 1,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      db.close()
    })
  })
})
