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

  it('submits a staged pointer while its live PTY is cold parked', async () => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const terminal = {
      ptyId,
      handle: 'term-parked',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId)
    const writePty = vi.fn(settledWriteStub())
    const markMailboxPointerEnterAttempted = vi.fn(() => true)
    const resolveMailbox = vi.fn(() => mailboxHandle)
    const settle = vi.fn(() => {
      state.settleFlight(ptyId, flight)
    })
    const target = {
      terminal,
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
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
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
    expect(resolveMailbox).toHaveBeenCalledWith(terminal, mailboxHandle)
    expect(markMailboxPointerEnterAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      writePty.mock.invocationCallOrder[0]!
    )
  })

  it('holds the Enter while a dialog is open and submits once the agent is idle again', async () => {
    const ptyId = 'pty-question'
    const mailboxHandle = 'run:run-1'
    const terminal = {
      ptyId,
      handle: 'term-question',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const target = { terminal, processIncarnation: 'inc-question' }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId)
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
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
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
    const terminal = {
      ptyId,
      handle: 'term-parked',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const expectedTarget = {
      terminal,
      processIncarnation: 'inc-parked'
    }
    const currentTarget = targetOverride
      ? { ...expectedTarget, terminal: { ...terminal, ...targetOverride } }
      : null
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId)
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
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive
      },
      {
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

  it('releases every reservation when a pending batch targets multiple PTYs', () => {
    const releaseMailboxPointerEnter = vi.fn()
    const messages = [
      {
        id: 'msg-a',
        type: 'status',
        sequence: 1,
        pointer_enter_pending: MAILBOX_POINTER_RESERVED,
        pointer_pty_id: 'pty-a',
        pointer_process_incarnation: 'inc-a'
      },
      {
        id: 'msg-b',
        type: 'status',
        sequence: 2,
        pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED,
        pointer_pty_id: 'pty-b',
        pointer_process_incarnation: 'inc-b'
      }
    ]

    const current = {
      ptyId: 'pty-current',
      handle: 'term-current',
      paneKeys: ['tab:leaf'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const resumed = resumePendingOrchestrationMailboxPointer({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a cross-PTY batch reaches only these two deps.
      deps: {
        getDb: () => ({ releaseMailboxPointerEnter }),
        resolveSubmitTarget: () => ({ terminal: current, processIncarnation: 'inc-current' })
      } as never,
      state: new OrchestrationMailboxPointerState(),
      terminal: current,
      mailboxHandle: 'run:run-1',
      messages,
      enterDelayMs: 0,
      settle: vi.fn(),
      redrive: vi.fn()
    })

    expect(resumed).toBe(false)
    expect(releaseMailboxPointerEnter).toHaveBeenCalledTimes(2)
    expect(releaseMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-a'],
      { ptyId: 'pty-a', processIncarnation: 'inc-a' },
      [MAILBOX_POINTER_RESERVED, MAILBOX_POINTER_WRITE_ATTEMPTED, MAILBOX_POINTER_ENTER_ATTEMPTED]
    )
    expect(releaseMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-b'],
      { ptyId: 'pty-b', processIncarnation: 'inc-b' },
      [MAILBOX_POINTER_RESERVED, MAILBOX_POINTER_WRITE_ATTEMPTED, MAILBOX_POINTER_ENTER_ATTEMPTED]
    )
  })

  it('does not submit after the parked PTY incarnation is replaced', async () => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const terminal = {
      ptyId,
      handle: 'term-parked',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const expectedTarget = {
      terminal,
      processIncarnation: 'inc-original'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId)
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(settledWriteStub())
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () => ({ areUnreadMessages: () => true, releaseMailboxPointerEnter }) as never,
        resolveSubmitTarget: () => ({ ...expectedTarget, processIncarnation: 'inc-replaced' }),
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
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
    const terminal = {
      ptyId,
      handle: 'term-teardown',
      paneKeys: ['tab-teardown:leaf-teardown'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const expectedTarget = {
      terminal,
      processIncarnation: 'inc-teardown'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId)
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
        isLeafPtyProvenAbsent: async () => false,
        isPtyAwaitingUserInput: () => false,
        writePty: vi.fn(settledWriteStub()),
        settle,
        redrive
      },
      {
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

  it('fails closed after restart following Enter acceptance before durable settlement', () => {
    const phase = MAILBOX_POINTER_ENTER_ATTEMPTED
    const ptyId = 'pty-surviving'
    const terminal = {
      ptyId,
      handle: 'term-surviving',
      paneKeys: ['tab-surviving:leaf-surviving'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const target = {
      terminal,
      processIncarnation: 'inc-surviving'
    }
    const settleMailboxPointerEnter = vi.fn()
    const releaseMailboxPointerEnter = vi.fn()
    const resumed = resumePendingOrchestrationMailboxPointer({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an attempted Enter reaches only these two deps.
      deps: {
        getDb: () => ({ settleMailboxPointerEnter, releaseMailboxPointerEnter }),
        resolveSubmitTarget: () => target
      } as never,
      state: new OrchestrationMailboxPointerState(),
      terminal,
      mailboxHandle: 'run:run-surviving',
      enterDelayMs: 0,
      settle: vi.fn(),
      redrive: vi.fn(),
      messages: [
        {
          id: 'msg-surviving',
          type: 'status',
          sequence: 1,
          pointer_enter_pending: phase,
          pointer_pty_id: ptyId,
          pointer_process_incarnation: target.processIncarnation
        }
      ]
    })

    expect(resumed).toBe(true)
    expect(settleMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-surviving'],
      { ptyId, processIncarnation: target.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED, MAILBOX_POINTER_ENTER_ATTEMPTED]
    )
    expect(releaseMailboxPointerEnter).not.toHaveBeenCalled()
  })

  it('settles a typed pointer it cannot read back after restart, freeing the terminal', async () => {
    const ptyId = 'pty-unreadable'
    const mailboxHandle = 'run:run-unreadable'
    const terminal = {
      ptyId,
      handle: 'term-unreadable',
      paneKeys: ['tab-unreadable:leaf-unreadable'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const target = { terminal, processIncarnation: 'inc-unreadable' }
    const state = new OrchestrationMailboxPointerState()
    const settleMailboxPointerEnter = vi.fn()
    const settle = vi.fn((settledPtyId: string, flight) => state.settleFlight(settledPtyId, flight))
    const resumed = resumePendingOrchestrationMailboxPointer({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unreadable composer reaches only these deps.
      deps: {
        getDb: () => ({ settleMailboxPointerEnter }),
        resolveSubmitTarget: () => target,
        getCliCommand: () => 'orca',
        readComposerDraft: async () => undefined
      } as never,
      state,
      terminal,
      mailboxHandle,
      enterDelayMs: 0,
      settle,
      redrive: vi.fn(),
      messages: [
        {
          id: 'msg-unreadable',
          type: 'status',
          sequence: 1,
          pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED,
          pointer_pty_id: ptyId,
          pointer_process_incarnation: target.processIncarnation
        }
      ]
    })

    expect(resumed).toBe(true)
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(settleMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-unreadable'],
      { ptyId, processIncarnation: target.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED]
    )
    expect(state.hasFlight(ptyId)).toBe(false)
    expect(state.hasActiveWatermark(mailboxHandle)).toBe(false)
  })

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

    it.each([
      ['the PTY is gone', { absent: true }],
      ['the process was replaced', { replaced: true }],
      ['a shell is in front', { shellInFront: true }]
    ])('sends no Enter when %s', async (_name, options) => {
      const { db, writePty, settle } = submitAfterRead(options)

      await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
      expect(writePty).not.toHaveBeenCalled()
      db.close()
    })

    it('defers the Enter while a dialog is open', async () => {
      const { db, writePty, settle, flight } = submitAfterRead({ dialogOpen: true })

      await vi.waitFor(() => expect(flight.deferredUntilIdle).toBe(true))
      expect(writePty).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
      db.close()
    })
  })

  it('sends no second Enter for unread mail whose Enter was already attempted', async () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'already entered'
    })
    const ptyId = 'pty-entered'
    const reservation = { ptyId, processIncarnation: 'inc-entered' }
    const terminal = {
      ptyId,
      handle: 'term-entered',
      paneKeys: ['tab-1:leaf-1'],
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true
    }
    const expectedTarget = { terminal, processIncarnation: reservation.processIncarnation }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    expect(db.stageMailboxPointerEnter([message.id], reservation)).toBe(true)
    expect(db.markMailboxPointerWriteAttempted([message.id], reservation)).toBe(true)
    expect(db.markMailboxPointerEnterAttempted([message.id], reservation)).toBe(true)
    const writePty = vi.fn(settledWriteStub())
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => 'run:run-1' } as never,
        state,
        getDb: () => db,
        resolveSubmitTarget: () => expectedTarget,
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
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).not.toHaveBeenCalled()
    db.close()
  })
})
