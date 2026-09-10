import { describe, expect, it, vi } from 'vitest'
import {
  type ProbeContractError,
  createBrowserSurfaceRegistry,
  createContextRollover,
  createImmutableCapsule,
  createProbeProgressTimeline,
  normalizeCoordinationTelemetry,
  reduceExecutionPackets,
  resolveLaunchProfile,
  validateAttemptDecisionGate,
  validateCoordinationTelemetry,
  validateCoordinatorTimeline,
  validateDetailReference,
  validateProbeArtifact,
  validateProgressTimeline,
  validateRetainedWorkerRelease,
  validateSerialTaskReuse,
  validateTargetsManifest
} from './run-maestro-live-probe.mjs'
import { artifact, browserReceipt, targetsManifest } from './maestro-live-probe-fixtures'

describe('Maestro live probe coordination contracts', () => {
  it('preserves active, blocked, and carry-forward partial progress below completion', () => {
    const timeline = createProbeProgressTimeline()
    expect(validateProgressTimeline(timeline)).toBe(timeline)
    expect(() =>
      validateProgressTimeline([...timeline, { ...timeline[1], percentage: 100 }])
    ).toThrow('below 100')
    expect(() =>
      validateProgressTimeline([
        ...timeline,
        { state: 'partial', percentage: 100, findings: [{ classification: 'carry_forward' }] }
      ])
    ).toThrow('below 100')
    expect(() =>
      validateProgressTimeline([
        ...timeline,
        { state: 'cleanup', percentage: 100, cleanup: true, findings: [] }
      ])
    ).toThrow('below 100')
    expect(() =>
      validateProgressTimeline([
        ...timeline,
        {
          state: 'complete',
          percentage: 100,
          cleanup: true,
          findings: [{ classification: 'blocking' }]
        }
      ])
    ).toThrow('Complete progress')
    expect(() =>
      validateCoordinationTelemetry({ wall_time_ms: 1, dispatches: 0, technical_attempts: 0 })
    ).toThrow('operational_terminal_failures')
    expect(normalizeCoordinationTelemetry(undefined)).toBeNull()
    expect(normalizeCoordinationTelemetry(null)).toBeNull()
  })

  it('preserves accepted receipts during single-writer reduction and gates parallel expansion', () => {
    const packets = [
      {
        id: 'packet-1',
        task_id: 'ORC-01',
        status: 'pending',
        receipt: { id: 'receipt-1', status: 'accepted' }
      },
      { id: 'packet-2', task_id: 'ORC-02', status: 'pending' }
    ]
    expect(reduceExecutionPackets(packets, 'single_writer')).toMatchObject({
      execution_mode: 'single_writer',
      pending_task_ids: ['ORC-01', 'ORC-02'],
      accepted_receipt_ids: ['receipt-1']
    })
    expect(() => reduceExecutionPackets(packets, 'parallel')).toThrow('independent')
    expect(
      reduceExecutionPackets(
        packets.map((packet) => ({
          ...packet,
          independence: 'independent',
          evidence_ref: 'file:evidence.json'
        })),
        'parallel'
      ).execution_mode
    ).toBe('parallel')
  })

  it('keeps detail references pinned to the exact workspace', () => {
    expect(
      validateDetailReference(
        { kind: 'finding', id: 'finding-1', workspace_key: 'folder:probe-workspace' },
        'folder:probe-workspace'
      )
    ).toEqual(expect.objectContaining({ kind: 'finding', id: 'finding-1' }))
    expect(() =>
      validateDetailReference(
        { kind: 'task', id: 'task-1', workspace_key: 'other' },
        'folder:probe-workspace'
      )
    ).toThrow('pinned workspace')
  })

  it('requires exact visible Browser proof and releases only the matching page', () => {
    expect(() => createBrowserSurfaceRegistry('folder:probe-workspace')).toThrow(
      'expectedProfileId'
    )
    const registry = createBrowserSurfaceRegistry('folder:probe-workspace', 'profile-1')
    const visibleReceipt = browserReceipt('page-visible', 'visible')
    registry.open(visibleReceipt)
    expect(registry.retain('page-visible')).toEqual({
      browser_page_id: 'page-visible',
      lifecycle: 'retained'
    })
    expect(() =>
      registry.release('page-visible', { browser_page_id: 'other-page', closed: true })
    ).toThrow('different Browser page')
    expect(
      registry.release('page-visible', { browser_page_id: 'page-visible', closed: true })
    ).toEqual({
      browser_page_id: 'page-visible',
      lifecycle: 'released'
    })
    registry.open(browserReceipt('page-offscreen-valid', 'offscreen'))
    expect(registry.list()).toEqual([
      expect.objectContaining({ browser_page_id: 'page-offscreen-valid', lifecycle: 'open' })
    ])
    expect(
      registry.release('page-offscreen-valid', {
        browser_page_id: 'page-offscreen-valid',
        closed: true
      })
    ).toMatchObject({ lifecycle: 'released' })
    expect(() =>
      registry.open(
        browserReceipt('page-downgraded', 'visible', { observed_visibility: 'offscreen' })
      )
    ).toThrow('silently downgraded')
  })

  it('rejects Browser receipts without a real state or with the wrong Harness profile', () => {
    const registry = createBrowserSurfaceRegistry('folder:probe-workspace', 'profile-1')
    expect(() =>
      registry.open(browserReceipt('page-missing-state', 'visible', { state: undefined }))
    ).toThrow('state is invalid')
    expect(() =>
      registry.open(browserReceipt('page-invalid-state', 'visible', { state: 'visible' }))
    ).toThrow('state is invalid')
    expect(() =>
      registry.open(browserReceipt('page-wrong-profile', 'visible', { profile_id: 'profile-2' }))
    ).toThrow('unexpected profile')
    expect(() =>
      registry.open(browserReceipt('page-user-owned', 'visible', { ownership: 'user' }))
    ).toThrow('Harness-owned')
    expect(() =>
      registry.open(browserReceipt('page-wrong-schema', 'visible', { schema_version: 2 }))
    ).toThrow('schema_version')
    expect(() =>
      registry.open(browserReceipt('page-wrong-protocol', 'visible', { protocol: 'other/v1' }))
    ).toThrow('protocol')
    const nestedPrivate = browserReceipt('page-nested-private-data', 'visible')
    Object.assign(nestedPrivate.evidence_receipt as Record<string, unknown>, {
      screenshot_bytes: 'not-allowed'
    })
    expect(() => registry.open(nestedPrivate)).toThrow('screenshot_bytes')
  })

  it('preserves one terminal across three acknowledged serial task capsules', () => {
    expect(
      validateSerialTaskReuse([
        {
          task_id: 'ORC-01',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:1',
          delivery_status: 'acknowledged'
        },
        {
          task_id: 'ORC-02',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:2',
          delivery_status: 'acknowledged'
        },
        {
          task_id: 'ORC-03',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:3',
          delivery_status: 'acknowledged'
        }
      ])
    ).toMatchObject({ terminal_handle: 'terminal-1', capsule_count: 3 })
    expect(() =>
      validateSerialTaskReuse([
        {
          task_id: 'ORC-01',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:1',
          delivery_status: 'acknowledged'
        },
        {
          task_id: 'ORC-02',
          terminal_handle: 'terminal-2',
          capsule_digest: 'sha256:2',
          delivery_status: 'acknowledged'
        },
        {
          task_id: 'ORC-03',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:3',
          delivery_status: 'acknowledged'
        }
      ])
    ).toThrow('one terminal')
    expect(() =>
      validateSerialTaskReuse([
        {
          task_id: 'ORC-01',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:1',
          delivery_status: 'acknowledged'
        },
        {
          task_id: 'ORC-02',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:2',
          delivery_status: 'failed'
        },
        {
          task_id: 'ORC-03',
          terminal_handle: 'terminal-1',
          capsule_digest: 'sha256:3',
          delivery_status: 'acknowledged'
        }
      ])
    ).toThrowError(expect.objectContaining<ProbeContractError>({ code: 'capsule_delivery_failed' }))
  })

  it('orders coordinator takeover after successor authority and rejects early reconciliation', () => {
    expect(
      validateCoordinatorTimeline([
        { phase: 'reserved', generation: 1 },
        { phase: 'spawned', generation: 1 },
        { phase: 'capsule_delivery_acknowledged', generation: 1 },
        { phase: 'coordinator_claimed', generation: 1 },
        { phase: 'authority_committed', generation: 1 },
        { phase: 'crashed', generation: 1 },
        { phase: 'restarted', generation: 2 },
        { phase: 'reserved', generation: 2 },
        { phase: 'spawned', generation: 2 },
        { phase: 'capsule_delivery_acknowledged', generation: 2 },
        { phase: 'coordinator_claimed', generation: 2 },
        { phase: 'authority_committed', generation: 2 },
        { phase: 'predecessor_reconciled', generation: 1 }
      ])
    ).toHaveLength(13)
    expect(() =>
      validateCoordinatorTimeline([
        { phase: 'reserved', generation: 1 },
        { phase: 'spawned', generation: 1 },
        { phase: 'capsule_delivery_acknowledged', generation: 1 },
        { phase: 'coordinator_claimed', generation: 1 },
        { phase: 'authority_committed', generation: 1 },
        { phase: 'crashed', generation: 1 },
        { phase: 'restarted', generation: 2 },
        { phase: 'predecessor_reconciled', generation: 1 },
        { phase: 'authority_committed', generation: 2 }
      ])
    ).toThrow('Predecessor reconciled')
  })

  it('rolls context exhaustion into a fresh session without provider resume', () => {
    const capsule = createImmutableCapsule({
      task: { id: 'ORC-02' },
      workspace_scope: { workspace_key: 'folder:probe-workspace' },
      launch_profile: resolveLaunchProfile({ provider: 'codex', model: 'terra', effort: 'medium' })
    })
    const resume = vi.fn(() => false)
    expect(
      createContextRollover({
        oldSession: {
          session_id: 'session-old',
          observation: 'context_exhausted',
          lifecycle: 'settled'
        },
        freshSession: { session_id: 'session-new', resumed: false },
        capsule,
        resume
      })
    ).toMatchObject({ observation: 'context_rollover', resumed: false })
    expect(resume).not.toHaveBeenCalled()
    expect(() =>
      createContextRollover({
        oldSession: {
          session_id: 'session-old',
          observation: 'context_exhausted',
          lifecycle: 'active'
        },
        freshSession: { session_id: 'session-new', resumed: false },
        capsule,
        resume: () => false
      })
    ).toThrow('settled')
  })

  it('requires an explicit decision id before a third technical attempt', () => {
    const attempts = [
      { attempt_id: 'attempt-1', kind: 'implementation' },
      { attempt_id: 'attempt-2', kind: 'repair' }
    ]
    expect(validateAttemptDecisionGate(attempts)).toEqual({ allowed: true, decision_id: null })
    const thirdAttempt = [...attempts, { attempt_id: 'attempt-3', kind: 'repair' }]
    expect(() => validateAttemptDecisionGate(thirdAttempt)).toThrow('decision id')
    expect(
      validateAttemptDecisionGate(thirdAttempt, {
        id: 'decision-authorize-3',
        authorize_third_attempt: true,
        attempt_id: 'attempt-3'
      })
    ).toEqual({ allowed: true, decision_id: 'decision-authorize-3' })
  })

  it('requires retained worker release proof', () => {
    expect(
      validateRetainedWorkerRelease({
        terminal_handle: 'terminal-retained',
        retained: true,
        released: true,
        process_tree_verified: true
      })
    ).toMatchObject({ terminal_handle: 'terminal-retained' })
    expect(() =>
      validateRetainedWorkerRelease({
        terminal_handle: 'terminal-retained',
        retained: true,
        released: false,
        process_tree_verified: false
      })
    ).toThrow('verified process cleanup')
  })

  it('requires telemetry base, explicit isolation, and fully closed resources in the artifact', () => {
    const targets = validateTargetsManifest(targetsManifest())
    expect(() =>
      validateProbeArtifact({ ...artifact(), coordination_telemetry: null }, targets)
    ).toThrow('telemetry base')
    expect(() => {
      const incomplete = { ...artifact() }
      delete incomplete.cleanup
      validateProbeArtifact(incomplete, targets)
    }).toThrow('cleanup is required')
    expect(() =>
      validateProbeArtifact(
        {
          ...artifact(),
          cleanup: {
            ...artifact().cleanup,
            open_browser_pages: 1
          }
        },
        targets
      )
    ).toThrow('open_browser_pages must be zero')
    expect(() =>
      validateProbeArtifact(
        {
          ...artifact(),
          cleanup: {
            ...artifact().cleanup,
            open_processes: 1
          }
        },
        targets
      )
    ).toThrow('open_processes must be zero')
    expect(() =>
      validateProbeArtifact(
        {
          ...artifact(),
          cleanup: { ...artifact().cleanup, unrelated_workspaces_touched: undefined }
        },
        targets
      )
    ).toThrow('outside its ownership')
    expect(() =>
      validateProbeArtifact(
        {
          ...artifact(),
          expected_profile_id: 'profile-2',
          browser_receipts: [
            browserReceipt('page-profile-2', 'visible', { profile_id: 'profile-2' })
          ]
        },
        targets
      )
    ).toThrow('caller-pinned Browser profile')
  })
})
