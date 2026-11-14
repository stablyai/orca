import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import {
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

afterEach(() => vi.useRealTimers())

it('revisits parked mail at positive mode expiry without a new terminal edge', async () => {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const { runtime } = createRuntime(db, { launchAgent: 'claude' })
  let observed = true
  const writes: string[] = []
  const write = (_id: string, data: string) => {
    writes.push(data)
    return true
  }
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => 'claude',
    inspectProcess: async () => ({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      ...(observed
        ? {
            foregroundObservation: {
              ptyId: PTY_ID,
              ptyIncarnationId: 'mailbox-incarnation',
              authorityGeneration: 'host-1',
              observationEpoch: 1,
              capturedAgeMs: 0,
              verdict: 'observed' as const,
              source: 'pty-master' as const,
              foregroundKind: 'non-shell' as const,
              processName: 'claude',
              inputMode: 'noninteractive' as const
            }
          }
        : {})
    })
  })
  try {
    const run = createBoundRun(db, 'Positive mode expires')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    runtime.onPtyData(
      PTY_ID,
      '\x1b]133;C\x07\x1b]0;claude\x07\x1b]7501;state=idle:app=claude-code\x07',
      Date.now()
    )
    // Composer observation registers the existing shared owner before immediate idle can settle.
    const composer = runtime.waitForFreshWorkerComposer(TERMINAL_HANDLE, 'claude', 20_000)
    const result = expect(composer).resolves.toMatchObject({ satisfied: true })
    await vi.advanceTimersByTimeAsync(4_000)
    await result
    expect(runtime.terminalAgentInputMode(TERMINAL_HANDLE)).toBe('noninteractive')
    const message = insertDirectRunMessage(db, run.id, 'Retained until current admission')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual([])
    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
    // A later inspection is unavailable; absence does not extend the expired positive refusal.
    observed = false
    await vi.advanceTimersByTimeAsync(17_000)
    expect(writes).toEqual([expect.stringContaining('You have 1 orchestration message'), '\r'])
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
  } finally {
    runtime.onPtyExit(PTY_ID, 0)
    db.close()
  }
})
