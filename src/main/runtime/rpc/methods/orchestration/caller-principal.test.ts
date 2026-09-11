import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session-record.test-fixture'
import { OrchestrationDb } from '../../../orchestration/db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../structured-worker-identity'
import { readStructuredAgentSessionRecord } from '../../../structured-worker-authority'
import type * as StructuredWorkerAuthority from '../../../structured-worker-authority'
import { resolveCallerPrincipal } from './caller-principal'

vi.mock('../../../structured-worker-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof StructuredWorkerAuthority>()
  return { ...actual, readStructuredAgentSessionRecord: vi.fn() }
})

const SESSION_ID = 'session-alpha-1'
const STRUCTURED_HANDLE = 'structworker_11111111-2222-4333-8444-555555555555'
const STRUCTURED_PANE_KEY = mintStructuredWorkerPaneKey(SESSION_ID)
const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function nativeRecord(
  leaseOverrides: Parameters<typeof agentSessionLeaseFixture>[0] = {}
): AgentSessionRecord {
  return agentSessionRecordFixture(
    agentSessionLeaseFixture({ runtimeKind: 'native', ...leaseOverrides })
  )
}

describe('resolveCallerPrincipal', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORDINATOR_PANE_KEY : null
    )
    structuredWorkerIdentities.clear()
    structuredWorkerIdentities.register({
      handle: STRUCTURED_HANDLE,
      sessionId: SESSION_ID,
      agent: 'claude',
      paneKey: STRUCTURED_PANE_KEY,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
      worktreeId: 'worktree-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    vi.mocked(readStructuredAgentSessionRecord).mockReturnValue(nativeRecord())
  })

  afterEach(() => {
    structuredWorkerIdentities.clear()
    db.close()
    vi.restoreAllMocks()
  })

  it('resolves a terminal handle to a pane principal', () => {
    const caller = resolveCallerPrincipal(runtime, {
      from: 'term_coord',
      requireBindableCaller: true
    })
    expect(caller.principal).toEqual({ kind: 'pane', paneKey: COORDINATOR_PANE_KEY })
    expect(caller.principalId).toBe(`pane:${COORDINATOR_PANE_KEY}`)
    expect(caller.waiterHandles).toEqual(['term_coord'])
    expect(caller.binding).toEqual({
      principalId: `pane:${COORDINATOR_PANE_KEY}`,
      terminalHandle: 'term_coord',
      paneKey: COORDINATOR_PANE_KEY
    })
    expect(caller.attested).toBe(false)
  })

  it('resolves a structured worker handle to a session principal', () => {
    const caller = resolveCallerPrincipal(runtime, {
      from: STRUCTURED_HANDLE,
      requireBindableCaller: true
    })
    expect(caller.principal).toEqual({ kind: 'session', sessionId: SESSION_ID })
    expect(caller.principalId).toBe(`session:${SESSION_ID}`)
    // The binding still carries the handle and the minted pane key so dual-write and mail
    // routing stay byte-identical with today.
    expect(caller.binding).toEqual({
      principalId: `session:${SESSION_ID}`,
      terminalHandle: STRUCTURED_HANDLE,
      paneKey: STRUCTURED_PANE_KEY
    })
    expect(caller.attested).toBe(false)
    expect(caller.ownerGeneration).toBe('7')
    expect(caller.workspaceId).toBe('workspace-1')
    expect(caller.hostScope).toEqual({ kind: 'local', hostId: 'local' })
    expect(caller.waiterHandles).toEqual([STRUCTURED_HANDLE])
  })

  it('returns one identical shape for both kinds', () => {
    const pane = resolveCallerPrincipal(runtime, {
      from: 'term_coord',
      requireBindableCaller: true
    })
    const session = resolveCallerPrincipal(runtime, {
      from: STRUCTURED_HANDLE,
      requireBindableCaller: true
    })
    expect(Object.keys(session).sort()).toEqual(Object.keys(pane).sort())
  })

  it('refuses a declared session id with no bearer', () => {
    // Session ids are public (tab ids embed them); accepting one would let any RPC caller
    // impersonate any native session.
    expect(() =>
      resolveCallerPrincipal(runtime, { agentSessionId: SESSION_ID, requireBindableCaller: true })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    expect(() =>
      resolveCallerPrincipal(runtime, {
        agentSessionId: SESSION_ID,
        runtimeFence: 7,
        requireBindableCaller: true
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it('refuses a declared session id alongside a pane bearer', () => {
    expect(() =>
      resolveCallerPrincipal(runtime, {
        from: 'term_coord',
        agentSessionId: SESSION_ID,
        requireBindableCaller: true
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it('treats declared session fields as corroboration for a structured bearer', () => {
    // Stale declared fence: the caller holds yesterday's identity.
    expect(() =>
      resolveCallerPrincipal(runtime, {
        from: STRUCTURED_HANDLE,
        runtimeFence: 6,
        requireBindableCaller: true
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    // Declared session id mismatching the bearer's session.
    expect(() =>
      resolveCallerPrincipal(runtime, {
        from: STRUCTURED_HANDLE,
        agentSessionId: 'session-other',
        requireBindableCaller: true
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    // Matching corroboration passes.
    expect(
      resolveCallerPrincipal(runtime, {
        from: STRUCTURED_HANDLE,
        agentSessionId: SESSION_ID,
        runtimeFence: 7,
        requireBindableCaller: true
      }).principalId
    ).toBe(`session:${SESSION_ID}`)
  })

  it('accepts fence 0 against a fence-0 lease', () => {
    // The lease validator allows fence 0; a .positive() schema would lock out fresh sessions.
    vi.mocked(readStructuredAgentSessionRecord).mockReturnValue(nativeRecord({ runtimeFence: 0 }))
    const caller = resolveCallerPrincipal(runtime, {
      from: STRUCTURED_HANDLE,
      runtimeFence: 0,
      requireBindableCaller: true
    })
    expect(caller.ownerGeneration).toBe('0')
  })

  it.each([
    ['claimStatus reserved', nativeRecord({ claimStatus: 'reserved' })],
    ['claimStatus conflicted', nativeRecord({ claimStatus: 'conflicted' })],
    ['claimStatus released', nativeRecord({ claimStatus: 'released' })],
    ['handoff in progress', nativeRecord({ handoffStage: 'preparing' })],
    ['unreconciled lease', nativeRecord({ unreconciled: true })],
    ['terminal-owned lease', nativeRecord({ runtimeKind: 'tui' })],
    [
      'non-local host',
      {
        ...nativeRecord(),
        location: { ...nativeRecord().location, executionHostId: 'ssh:remote' as const }
      }
    ],
    ['missing record', null]
  ])('refuses a structured bearer whose lease is not current: %s', (_label, record) => {
    vi.mocked(readStructuredAgentSessionRecord).mockReturnValue(record)
    expect(() =>
      resolveCallerPrincipal(runtime, { from: STRUCTURED_HANDLE, requireBindableCaller: true })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it('requires some credential', () => {
    expect(() => resolveCallerPrincipal(runtime, { requireBindableCaller: true })).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' })
    )
  })

  it('still delegates evidence attestation, immediately or deferred', () => {
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      hostScope: { kind: 'local', hostId: 'local' },
      paneKey: COORDINATOR_PANE_KEY,
      terminalHandle: 'term_other',
      processIncarnation: 'incarnation-1',
      launchTokenHash: 'hash-1'
    })
    const evidence = { terminalHandle: 'term_other', paneKey: 'p', launchToken: 't' }
    expect(() =>
      resolveCallerPrincipal(runtime, {
        from: 'term_coord',
        evidence,
        requireBindableCaller: true
      })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
    const deferred = resolveCallerPrincipal(runtime, {
      from: 'term_coord',
      evidence,
      requireBindableCaller: true,
      deferEvidenceAssertion: true
    })
    expect(() => deferred.attestDeclaredCaller()).toThrowError(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    const sessionDeferred = resolveCallerPrincipal(runtime, {
      from: STRUCTURED_HANDLE,
      evidence,
      requireBindableCaller: true,
      deferEvidenceAssertion: true
    })
    expect(() => sessionDeferred.attestDeclaredCaller()).toThrowError(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
  })

  it('resolves null for a bearer with no stable pane unless bindability is required', () => {
    expect(resolveCallerPrincipal(runtime, { from: 'term_stale' })).toBeNull()
    expect(() =>
      resolveCallerPrincipal(runtime, { from: 'term_stale', requireBindableCaller: true })
    ).toThrowError(expect.objectContaining({ code: 'stable_pane_required' }))
  })

  it('prefers a declared pane key over the live pane fallback', () => {
    const caller = resolveCallerPrincipal(runtime, {
      from: 'term_stale',
      paneKey: 'tab_declared:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    expect(caller?.principalId).toBe('pane:tab_declared:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  })
})
