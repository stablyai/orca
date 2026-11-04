import { afterEach, describe, expect, it, vi } from 'vitest'
import { WRITE_ACCEPTED } from '../../../shared/pty-write-settlement'
import { formatMessagePointer } from './formatter'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { ORCHESTRATION_TYPING_QUIET_MS } from './orchestration-typing-quiet'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'

const terminal: OrchestrationMailboxTerminal = {
  ptyId: 'pty-1',
  handle: 'term_1',
  paneKeys: ['tab-1:pane:1'],
  lastAgentStatus: 'idle',
  lastAgentStatusObservedLive: true
}

function createDelivery(overrides?: {
  lastUserInputAt?: number
  windowFocused?: boolean
  now?: number
}): {
  delivery: OrchestrationMailboxPointerDelivery<{ typeFilter?: string[] }>
  writePty: ReturnType<typeof vi.fn>
  redriveMailbox: ReturnType<typeof vi.fn>
} {
  const writePty = vi.fn(() => WRITE_ACCEPTED)
  const redriveMailbox = vi.fn()
  const delivery = new OrchestrationMailboxPointerDelivery({
    mailboxOwner: { resolve: () => 'run:run_1' } as never,
    deliveryTarget: {
      deferForAbsenceProbe: () => false,
      resolveTerminalHandle: (handle: string) => handle
    } as never,
    getDb: () =>
      ({
        getPendingMailboxPointerMessages: () => [],
        getUndeliveredUnreadMessages: () => [{ id: 'm1', type: 'task_result', sequence: 1 }],
        stageMailboxPointerEnter: () => true,
        markMailboxPointerWriteAttempted: () => true,
        areUnreadMessages: () => true,
        markAsDelivered: vi.fn()
      }) as never,
    isAgentSettledForDelivery: () => true,
    isPtyAwaitingUserInput: () => false,
    getTerminal: () => terminal,
    getMessageWaiters: () => undefined,
    getCliCommand: () => 'orca' as const,
    resolveSubmitTarget: () => ({
      terminal,
      processIncarnation: 'inc-1'
    }),
    isLeafPtyProvenAbsent: async () => false,
    redriveMailbox,
    writePty,
    lastUserInputAt: () => overrides?.lastUserInputAt,
    isOrcaWindowFocused: () => overrides?.windowFocused ?? true,
    now: () => overrides?.now ?? 10_000
  })
  return { delivery, writePty, redriveMailbox }
}

describe('mailbox pointer delivery typing quiet (#14832)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers the pointer write when this PTY had user input in the last 5s and the window is focused', () => {
    vi.useFakeTimers()
    const { delivery, writePty, redriveMailbox } = createDelivery({
      lastUserInputAt: 10_000 - 800,
      windowFocused: true,
      now: 10_000
    })

    delivery.deliver(terminal, { mailboxHandle: 'run:run_1' })

    expect(writePty).not.toHaveBeenCalled()
    expect(redriveMailbox).not.toHaveBeenCalled()

    vi.advanceTimersByTime(ORCHESTRATION_TYPING_QUIET_MS - 800 - 1)
    expect(redriveMailbox).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(redriveMailbox).toHaveBeenCalledWith('run:run_1', undefined)
  })

  it('writes the pointer when the window is unfocused even if this PTY had recent keys', () => {
    const { delivery, writePty } = createDelivery({
      lastUserInputAt: 9_900,
      windowFocused: false,
      now: 10_000
    })

    delivery.deliver(terminal, { mailboxHandle: 'run:run_1' })

    expect(writePty).toHaveBeenCalledWith('pty-1', formatMessagePointer(1, 'run:run_1'))
  })

  it('writes the pointer when this PTY has no recent user input', () => {
    const { delivery, writePty } = createDelivery({
      windowFocused: true,
      now: 10_000
    })

    delivery.deliver(terminal, { mailboxHandle: 'run:run_1' })

    expect(writePty).toHaveBeenCalledWith('pty-1', formatMessagePointer(1, 'run:run_1'))
  })
})
