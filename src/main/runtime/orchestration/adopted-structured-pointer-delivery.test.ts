import type { WriteSettlement } from '../../../shared/pty-write-settlement'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionPtyWriteGate } from '../agent-session-pty-write-gate'
import { OrcaRuntimeWithWriteOrchestrationPointerPty } from '../orca-runtime-write-orchestration-pointer-pty'
import { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../orca-runtime-get-pty-record-for-pane-key'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PTY_ID = 'pty_adopted'

// Both methods are protected, and a subclass is the sanctioned way to reach them. The probes
// borrow the REAL implementations through the real prototype chain; a re-declared copy would pin
// nothing.
class PointerWriteProbe extends OrcaRuntimeWithWriteOrchestrationPointerPty {
  probeWritePointer(ptyId: string, data: string): WriteSettlement | Promise<WriteSettlement> {
    return this.writeOrchestrationPointerPty(ptyId, data)
  }
}

class MailboxTargetProbe extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  probeResolveTarget(mailboxHandle: string): unknown {
    return this.resolveStructuredMailboxTarget(mailboxHandle)
  }
}

/** A probe instance whose prototype chain is the real class, with only its state stubbed. */
function probe<TProbe extends object, TState extends object>(
  prototype: TProbe,
  state: TState
): TProbe & TState {
  return Object.assign(Object.create(prototype), state) as TProbe & TState
}

/** A pane bound to a session a settled NATIVE owner holds — the adopted-TUI state. */
function bindNativeOwnedPane(overrides: Partial<AgentSessionRecord['lease']> = {}): void {
  agentSessionPtyWriteGate.attachRecordLookup(
    (sessionId) =>
      ({
        sessionId,
        location: { executionHostId: 'local', wslDistro: null },
        lease: {
          sessionId,
          runtimeKind: 'native',
          claimStatus: 'live',
          handoffStage: null,
          unreconciled: false,
          ownerProcess: { pid: 4242 },
          runtimeFence: 7,
          ...overrides
        }
      }) as unknown as AgentSessionRecord
  )
  agentSessionPtyWriteGate.bindPty(PTY_ID, SESSION_ID)
}

afterEach(() => {
  agentSessionPtyWriteGate.detachRecordLookup()
  vi.restoreAllMocks()
})

describe('an orchestration pointer aimed at an adopted pane', () => {
  it('reaches no provider and never reports a write failure to the renderer', () => {
    bindNativeOwnedPane()
    const write = vi.fn(() => true)
    const writeWithSettlement = vi.fn(async () => true)
    const stub = {
      orchestrationPointerAdmissionByPtyId: new Map(),
      ptyController: { write, writeWithSettlement }
    }
    // Zero bytes: the controller path would re-admit, refuse again, and fire
    // `pty:writeUnavailable`, whose renderer handler runs transport RECOVERY on a healthy pane.
    // A proven refusal, not a bare false: the settlement vocabulary keeps "declined before any
    // byte moved" distinct from "we lost track", which is what a durable reservation reads.
    expect(
      probe(PointerWriteProbe.prototype, stub).probeWritePointer(
        PTY_ID,
        'You have 1 orchestration message.'
      )
    ).toEqual({ outcome: 'refused', reason: 'write_gate_denied' })
    expect(write).not.toHaveBeenCalled()
    expect(writeWithSettlement).not.toHaveBeenCalled()
  })

  it('still writes through when nothing owns the pane', () => {
    const write = vi.fn(() => true)
    // The gate admits an unbound pane, so the bytes reach the provider and its own settlement is
    // what the caller gets back.
    const writeWithSettlement = vi.fn(() => ({ outcome: 'accepted' }) as const)
    const stub = {
      orchestrationPointerAdmissionByPtyId: new Map(),
      ptyController: { write, writeWithSettlement }
    }
    expect(
      probe(PointerWriteProbe.prototype, stub).probeWritePointer('pty_unbound', 'pointer')
    ).toEqual({ outcome: 'accepted' })
    expect(writeWithSettlement).toHaveBeenCalledTimes(1)
  })
})

describe('the mailbox target for an adopted pane', () => {
  function targetStub() {
    return probe(MailboxTargetProbe.prototype, {
      _orchestrationDb: {
        getDispatchContextById: () => ({ assignee_handle: 'term_adopted' })
      },
      getLiveLeafForHandle: () => ({ leaf: { ptyId: PTY_ID } })
    })
  }

  it('routes the mailbox to the owning session so the nudge travels as a turn', () => {
    bindNativeOwnedPane()
    const target = targetStub().probeResolveTarget('dispatch:d1') as {
      sessionId: string
      dispatchId: string
      refusal?: { ownerRuntimeKind: string }
    } | null
    expect(target).toMatchObject({ sessionId: SESSION_ID, dispatchId: 'd1' })
    expect(target?.refusal?.ownerRuntimeKind).toBe('native')
  })

  it('leaves a mid-handoff lease to the PTY lane', () => {
    bindNativeOwnedPane({ handoffStage: 'preparing' })
    expect(targetStub().probeResolveTarget('dispatch:d1')).toBeNull()
  })

  it('leaves an unowned pane to the PTY lane', () => {
    expect(targetStub().probeResolveTarget('dispatch:d1')).toBeNull()
  })
})
