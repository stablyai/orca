import { describe, expect, it, vi } from 'vitest'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import { OrchestrationDb } from './db'
import { resumePendingOrchestrationMailboxPointer } from './mailbox-pointer-resume'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import { settledWriteStub, stubWriteSettlement } from '../../providers/settled-pty-write-stub'
import type { WriteSettlement } from '../../../shared/pty-write-settlement'

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
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-reused',
      processIncarnation: oldReservation.processIncarnation
    }
    const state = new OrchestrationMailboxPointerState()
    const oldFlight = state.beginFlight(ptyId)
    state.setWatermark('run:run-1', 1, ptyId, 'tab-1:leaf-1')
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
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
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

  it('submits a staged pointer while its live PTY is cold parked', async () => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    const writePty = vi.fn(settledWriteStub())
    const markMailboxPointerEnterAttempted = vi.fn(() => true)
    const resolveMailbox = vi.fn(() => mailboxHandle)
    const settle = vi.fn(() => {
      state.settleFlight(ptyId, flight)
    })
    const target = {
      leaf,
      terminalHandle: 'term-parked',
      processIncarnation: 'inc-parked'
    }

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: resolveMailbox } as never,
        state,
        getDb: () =>
          ({
            areUnreadMessages: () => true,
            markMailboxPointerEnterAttempted,
            settleMailboxPointerEnter: vi.fn()
          }) as never,
        resolveSubmitTarget: () => target,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget: target
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).toHaveBeenCalledOnce()
    expect(writePty).toHaveBeenCalledWith(ptyId, '\r')
    expect(resolveMailbox).toHaveBeenCalledWith(leaf, undefined, {
      terminalHandle: 'term-parked'
    })
    expect(markMailboxPointerEnterAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      writePty.mock.invocationCallOrder[0]!
    )
  })

  it('holds the Enter while a dialog is open and submits once the agent is idle again', async () => {
    const ptyId = 'pty-question'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: '✳ Claude Code'
    }
    const target = { leaf, terminalHandle: 'term-question', processIncarnation: 'inc-question' }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    let dialogOpen = true
    const writePty = vi.fn(settledWriteStub())
    const markMailboxPointerEnterAttempted = vi.fn(() => true)
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))
    const isPtyAwaitingUserInput = vi.fn(() => dialogOpen)

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () =>
          ({
            areUnreadMessages: () => true,
            markMailboxPointerEnterAttempted,
            settleMailboxPointerEnter: vi.fn()
          }) as never,
        resolveSubmitTarget: () => target,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget: target
      }
    )

    await vi.waitFor(() => expect(isPtyAwaitingUserInput).toHaveBeenCalledWith(ptyId))
    await Promise.resolve()
    expect(writePty).not.toHaveBeenCalled()
    expect(markMailboxPointerEnterAttempted).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    expect(flight.deferredUntilIdle).toBe(true)

    state.takeDeferredEnter(ptyId)?.()
    await vi.waitFor(() => expect(isPtyAwaitingUserInput).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(writePty).not.toHaveBeenCalled()

    dialogOpen = false
    state.takeDeferredEnter(ptyId)?.()
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).toHaveBeenCalledOnce()
    expect(writePty).toHaveBeenCalledWith(ptyId, '\r')
  })

  it.each([
    ['working', { lastAgentStatus: 'working' as const }, true],
    ['permission', { lastAgentStatus: 'permission' as const }, false],
    ['stale', null, false]
  ])('handles a parked target that becomes %s', async (_name, targetOverride, shouldSubmit) => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-parked',
      processIncarnation: 'inc-parked'
    }
    const currentTarget = targetOverride
      ? { ...expectedTarget, leaf: { ...leaf, ...targetOverride } }
      : null
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(settledWriteStub())
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))
    const redrive = vi.fn()
    const markMailboxPointerEnterAttempted = vi.fn(() => true)
    const settleMailboxPointerEnter = vi.fn()

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () =>
          ({
            areUnreadMessages: () => true,
            markMailboxPointerEnterAttempted,
            releaseMailboxPointerEnter,
            settleMailboxPointerEnter
          }) as never,
        resolveSubmitTarget: () => currentTarget,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    if (shouldSubmit) {
      expect(markMailboxPointerEnterAttempted).toHaveBeenCalledWith(['msg-1'], {
        ptyId,
        processIncarnation: expectedTarget.processIncarnation
      })
      expect(writePty).toHaveBeenCalledWith(ptyId, '\r')
      expect(releaseMailboxPointerEnter).not.toHaveBeenCalled()
    } else {
      expect(writePty).not.toHaveBeenCalled()
      if (targetOverride) {
        expect(settleMailboxPointerEnter).toHaveBeenCalledWith(
          ['msg-1'],
          { ptyId, processIncarnation: expectedTarget.processIncarnation },
          [MAILBOX_POINTER_WRITE_ATTEMPTED]
        )
        expect(releaseMailboxPointerEnter).not.toHaveBeenCalled()
        expect(redrive).not.toHaveBeenCalled()
      } else {
        expect(releaseMailboxPointerEnter).toHaveBeenCalledWith(
          ['msg-1'],
          { ptyId, processIncarnation: expectedTarget.processIncarnation },
          [MAILBOX_POINTER_WRITE_ATTEMPTED]
        )
        expect(redrive).toHaveBeenCalledWith(mailboxHandle, true)
      }
    }
  })

  it('releases all persisted phases by their original targets across PTY changes', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const mailboxHandle = 'run:run-1'
      const first = db.insertMessage({ from: 'a', to: mailboxHandle, subject: 'unwritten' })
      const second = db.insertMessage({ from: 'a', to: mailboxHandle, subject: 'ambiguous' })
      const firstTarget = { ptyId: 'pty-a', processIncarnation: 'inc-a' }
      const secondTarget = { ptyId: 'pty-b', processIncarnation: 'inc-b' }
      expect(db.stageMailboxPointerEnter([first.id], firstTarget)).toBe(true)
      expect(db.stageMailboxPointerEnter([second.id], secondTarget)).toBe(true)
      expect(db.markMailboxPointerWriteAttempted([second.id], secondTarget)).toBe(true)
      const messages = db.getPendingMailboxPointerMessages(mailboxHandle)
      const settleMailboxPointerEnter = vi.spyOn(db, 'settleMailboxPointerEnter')
      const releaseMailboxPointerEnter = vi.spyOn(db, 'releaseMailboxPointerEnter')
      const leaf: OrchestrationMailboxLeaf = {
        tabId: 'tab',
        leafId: 'leaf',
        paneRuntimeId: 1,
        ptyId: 'pty-current',
        writable: true,
        lastAgentStatus: 'idle',
        lastAgentStatusObservedLive: true,
        lastOscTitle: 'Codex done'
      }
      const getDb = () => db
      const getLeafKey = (tabId: string, leafId: string) => `${tabId}:${leafId}`
      const deps = {
        getDb,
        mailboxOwner: new OrchestrationMailboxOwner({
          getDb,
          getLeaf: () => leaf,
          getLeafKey,
          getTerminalHandleForLeafKey: () => 'term-current',
          getTerminalProcessIncarnation: () => 'inc-current',
          onRoutedMessageTypes: vi.fn(),
          onForeignMailboxRouted: vi.fn()
        }),
        deliveryTarget: new OrchestrationMailboxDeliveryTarget({
          getDb,
          getTerminalHandleForPaneKey: () => 'term-current',
          hasTerminalHandle: (handle) => handle === 'term-current',
          isStructuredSessionOwner: () => false,
          canProbePtyLiveness: () => false,
          controllerKnowsPtyIsLive: (ptyId) => ptyId === leaf.ptyId,
          isLeafPtyProvenAbsent: async () => false
        }),
        getLeaf: () => leaf,
        getLeafKey,
        getLiveLeafForHandle: () => leaf,
        isAgentSettledForDelivery: () => true,
        getMessageWaiters: () => undefined,
        isPtyAwaitingUserInput: () => false,
        getCliCommand: () => 'orca',
        getTerminalHandleForLeafKey: () => 'term-current',
        resolveSubmitTarget: () => ({
          leaf,
          terminalHandle: 'term-current',
          processIncarnation: 'inc-current'
        }),
        isLeafPtyProvenAbsent: async () => false,
        redriveMailbox: vi.fn(),
        writePty: vi.fn(settledWriteStub())
      } satisfies PointerDeliveryDependencies<OrchestrationMessageWaiter>
      const resumed = resumePendingOrchestrationMailboxPointer({
        deps,
        state: new OrchestrationMailboxPointerState(),
        leaf,
        mailboxHandle,
        messages,
        enterDelayMs: 0,
        leafKey: 'tab:leaf',
        settle: vi.fn(),
        redrive: vi.fn()
      })

      expect(resumed).toBe(false)
      expect(releaseMailboxPointerEnter).toHaveBeenCalledTimes(2)
      expect(releaseMailboxPointerEnter).toHaveBeenCalledWith([first.id], firstTarget, [
        MAILBOX_POINTER_RESERVED,
        MAILBOX_POINTER_WRITE_ATTEMPTED,
        MAILBOX_POINTER_ENTER_ATTEMPTED
      ])
      expect(releaseMailboxPointerEnter).toHaveBeenCalledWith([second.id], secondTarget, [
        MAILBOX_POINTER_RESERVED,
        MAILBOX_POINTER_WRITE_ATTEMPTED,
        MAILBOX_POINTER_ENTER_ATTEMPTED
      ])
      expect(settleMailboxPointerEnter).not.toHaveBeenCalled()
      for (const message of [first, second]) {
        expect(db.getMessageById(message.id)).toMatchObject({
          pointer_enter_pending: 0,
          pointer_pty_id: null,
          pointer_process_incarnation: null,
          delivered_at: null
        })
      }
      expect(deps.writePty).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('does not submit after the parked PTY incarnation is replaced', async () => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-parked',
      processIncarnation: 'inc-original'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(settledWriteStub())
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () => ({ areUnreadMessages: () => true, releaseMailboxPointerEnter }) as never,
        resolveSubmitTarget: () => ({ ...expectedTarget, processIncarnation: 'inc-replaced' }),
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).not.toHaveBeenCalled()
    expect(releaseMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-1'],
      { ptyId, processIncarnation: expectedTarget.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED]
    )
  })

  it('settles without redriving when teardown closes the database before rollback', async () => {
    const ptyId = 'pty-teardown'
    const mailboxHandle = 'run:run-teardown'
    const leaf = {
      tabId: 'tab-teardown',
      leafId: 'leaf-teardown',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-teardown',
      processIncarnation: 'inc-teardown'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-teardown:leaf-teardown')
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))
    const redrive = vi.fn()

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () =>
          ({
            areUnreadMessages: () => true,
            markAsUndelivered: () => {
              throw new Error('database is not open')
            }
          }) as never,
        resolveSubmitTarget: () => null,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty: vi.fn(settledWriteStub()),
        settle,
        redrive
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-teardown', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(redrive).not.toHaveBeenCalled()
  })

  it.each([
    ['pointer acceptance', MAILBOX_POINTER_WRITE_ATTEMPTED],
    ['Enter acceptance', MAILBOX_POINTER_ENTER_ATTEMPTED]
  ])('fails closed after restart following %s before durable settlement', (_boundary, phase) => {
    const ptyId = 'pty-surviving'
    const mailboxHandle = 'run:run-surviving'
    const leaf = {
      tabId: 'tab-surviving',
      leafId: 'leaf-surviving',
      paneRuntimeId: 1,
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const target = {
      leaf,
      terminalHandle: 'term-surviving',
      processIncarnation: 'inc-surviving'
    }
    const settleMailboxPointerEnter = vi.fn()
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(settledWriteStub())

    const resumed = resumePendingOrchestrationMailboxPointer({
      deps: {
        getDb: () => ({ settleMailboxPointerEnter, releaseMailboxPointerEnter }) as never,
        resolveSubmitTarget: () => target,
        writePty
      } as never,
      state: new OrchestrationMailboxPointerState(),
      leaf,
      mailboxHandle,
      messages: [
        {
          id: 'msg-surviving',
          type: 'status',
          sequence: 1,
          pointer_enter_pending: phase,
          pointer_pty_id: ptyId,
          pointer_process_incarnation: target.processIncarnation
        }
      ],
      enterDelayMs: 0,
      leafKey: 'tab-surviving:leaf-surviving',
      settle: vi.fn(),
      redrive: vi.fn()
    })

    expect(resumed).toBe(true)
    expect(settleMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-surviving'],
      { ptyId, processIncarnation: target.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED, MAILBOX_POINTER_ENTER_ATTEMPTED]
    )
    expect(releaseMailboxPointerEnter).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
  })
})
