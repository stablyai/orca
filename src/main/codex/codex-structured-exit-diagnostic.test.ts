import { describe, expect, it, vi } from 'vitest'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'

type LifecycleBatch = { settlementId: string; mutations: JournalLifecycleMutationInput[] }

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

const TURN_STARTED = notification('turn/started', { turn: { id: TURN_ID } })

function closeWith(
  reason: string,
  cause: 'requested-close' | 'unexpected-exit',
  options: { turnRunning: boolean } = { turnRunning: true }
): LifecycleBatch[] {
  const batches: LifecycleBatch[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: vi.fn(),
    appendTombstone: vi.fn(),
    publish: vi.fn(),
    tryAppendLifecycleBatch: (settlementId, mutations) => {
      batches.push({ settlementId, mutations: [...mutations] })
      return { accepted: true }
    },
    tryPublish: () => ({ accepted: true })
  }
  const translator = createCodexJournalTranslator({ sink, primaryThreadId: () => THREAD_ID })
  if (options.turnRunning) {
    translator.handle(TURN_STARTED)
  }
  translator.handle({
    type: 'ended',
    sessionId: SESSION_ID,
    reason,
    cause,
    fence: 7,
    acquisitionGeneration: 'generation-1'
  })
  return batches
}

function exitDiagnostics(batches: readonly LifecycleBatch[]): string[] {
  return batches
    .flatMap((batch) => batch.mutations)
    .flatMap((mutation) =>
      mutation.kind === 'item' && mutation.body.kind === 'status' ? [mutation.body.text] : []
    )
    .filter((text) => text.startsWith('The provider stopped:'))
}

describe('codex provider-close exit diagnostic', () => {
  // CX1 lost the one field separating an auth failure from an OOM kill: the close settled the turn
  // and dropped the provider's own reason, so three investigations could not say why the child went.
  it('carries the provider reason into the settlement that interrupts a running turn', () => {
    const batches = closeWith('app-server handshake failed: exit code 9', 'requested-close')

    expect(batches.some((batch) => batch.settlementId.startsWith('provider-exit:'))).toBe(true)
    expect(exitDiagnostics(batches)).toEqual([
      'The provider stopped: app-server handshake failed: exit code 9'
    ])
  })

  // An unexpected exit already has an owner: the host renders its reason. Recording it here too
  // would double-report the same stop in the same journal.
  it('leaves an unexpected exit to the host that already records it', () => {
    expect(exitDiagnostics(closeWith('lost child', 'unexpected-exit'))).toEqual([])
  })

  it('redacts credentials and paths a provider may hand back in its exit text', () => {
    const [diagnostic] = exitDiagnostics(
      closeWith(
        'auth refused: Bearer abcdefghijklmnopqrstuvwxyz0123456789 reading "/home/user/.codex/auth.json"',
        'requested-close'
      )
    )

    expect(diagnostic).toBeDefined()
    expect(diagnostic).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(diagnostic).not.toContain('/home/user/.codex/auth.json')
    expect(diagnostic).toContain('[redacted-secret]')
  })

  it('bounds an exit reason that arrives as a whole stderr dump', () => {
    const [diagnostic] = exitDiagnostics(closeWith('E'.repeat(20_000), 'requested-close'))

    expect(diagnostic).toBeDefined()
    expect((diagnostic ?? '').length).toBeLessThanOrEqual(600)
  })

  it('stays quiet when no turn was cut short', () => {
    expect(exitDiagnostics(closeWith('codex session closed', 'requested-close', {
      turnRunning: false
    }))).toEqual([])
  })

  it('stays quiet when the provider reported no reason', () => {
    expect(exitDiagnostics(closeWith('   ', 'requested-close'))).toEqual([])
  })
})
