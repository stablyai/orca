import {
  reduceExecutionPackets,
  resolveLaunchProfile,
  createProbeProgressTimeline
} from './run-maestro-live-probe.mjs'

/** Frozen probe inputs shared by both live-probe specs, so neither spec imports the other. */
export function targetsManifest() {
  return {
    schema_version: 1,
    orca: {
      root: '/tmp/orca-target',
      revision: 'a'.repeat(40),
      repository_id: 'orca-repository'
    },
    'my-llm-kit': {
      root: '/tmp/my-llm-kit-target',
      revision: 'b'.repeat(40),
      repository_id: 'my-llm-kit-repository'
    },
    execution_workspace: {
      execution_host_id: 'local',
      kind: 'folder',
      workspace_key: 'folder:probe-workspace',
      browser_profile_id: 'profile-1'
    },
    runtime_probe: {
      command: process.execPath,
      args: ['probe-child.mjs'],
      cwd: '/tmp/orca-target',
      timeout_ms: 500,
      max_output_bytes: 1024
    },
    expected_launch_profile: {
      provider: 'codex',
      model: 'terra',
      effort: 'medium'
    }
  }
}

export function browserReceipt(
  browserPageId: string,
  requestedVisibility: 'visible' | 'offscreen',
  overrides: Record<string, unknown> = {}
) {
  const visible = requestedVisibility === 'visible'
  return {
    schema_version: 1,
    protocol: 'maestro-browser-surface/v1',
    surface_id: `surface-${browserPageId}`,
    request_id: `request-${browserPageId}`,
    run_id: 'run-1',
    task_id: 'ORC-01',
    attempt_id: 'attempt-1',
    agent_id: 'agent-1',
    owner_principal: 'harness-orc',
    ownership: 'harness',
    execution_host_id: 'local',
    workspace_key: 'folder:probe-workspace',
    browser_page_id: browserPageId,
    title: 'Harness probe page',
    url: 'https://example.test/probe',
    origin: 'https://example.test',
    profile_id: 'profile-1',
    requested_visibility: requestedVisibility,
    observed_visibility: requestedVisibility,
    viewport: { width: 1280, height: 720, device_scale_factor: 1 },
    retention: 'release_when_settled',
    state: 'active',
    focus_receipt: {
      requested: visible,
      workspace_activated: visible,
      exact_page_selected: visible,
      native_pane_paint: visible ? 'painted' : 'unobserved',
      observed_at: visible ? '2026-08-24T00:00:00.000Z' : null,
      unavailable_reason: null
    },
    evidence_receipt: visible
      ? {
          protocol: 'maestro-browser-evidence/v1',
          artifact_ref: `file:${browserPageId}.png`,
          artifact_hash: `sha256:${'0'.repeat(64)}`,
          format: 'png',
          dimensions: { width: 1280, height: 720, device_scale_factor: 1 },
          route_or_component: 'probe',
          state: 'visible',
          theme: 'light',
          source_revision: 'r16',
          capture_mode: 'native-viewport',
          captured_at: '2026-08-24T00:00:00.000Z',
          vision_review: {
            outcome: 'pass',
            reviewer: 'probe',
            observation: 'Visible native evidence receipt'
          }
        }
      : null,
    release_receipt: {
      requested: false,
      outcome: 'not_requested',
      exact_page_closed: false,
      profile_affected: false,
      observed_at: null,
      reason: null
    },
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z',
    ...overrides
  }
}

export function artifact() {
  const launchProfile = resolveLaunchProfile({
    provider: 'codex',
    model: 'terra',
    effort: 'medium'
  })
  const executionPackets = [
    {
      id: 'packet-1',
      task_id: 'ORC-01',
      status: 'pending',
      receipt: { id: 'receipt-1', status: 'accepted' },
      independence: 'independent',
      evidence_ref: 'file:packet-1.json'
    },
    {
      id: 'packet-2',
      task_id: 'ORC-02',
      status: 'pending',
      independence: 'independent',
      evidence_ref: 'file:packet-2.json'
    }
  ]
  return {
    schema_version: 1,
    task_id: 'ORC-11P',
    execution_workspace: { workspace_key: 'folder:probe-workspace' },
    expected_profile_id: 'profile-1',
    attempts: [
      { attempt_id: 'attempt-1', kind: 'implementation' },
      { attempt_id: 'attempt-2', kind: 'repair' }
    ],
    decision: null,
    expected_launch_profile: launchProfile,
    observed_launch_profile: launchProfile,
    fresh_launch_receipt: {
      fresh: true,
      phase: 'fresh_launch',
      session_id: 'session-new',
      prior_session_id: 'session-old',
      profile: launchProfile
    },
    context_rollover: {
      old_session: {
        session_id: 'session-old',
        observation: 'context_exhausted',
        lifecycle: 'settled'
      },
      fresh_session: { session_id: 'session-new', resumed: false },
      capsule: { byte_count: 128, digest: `sha256:${'1'.repeat(64)}` }
    },
    retained_worker_release: {
      terminal_handle: 'terminal-retained',
      retained: true,
      released: true,
      process_tree_verified: true
    },
    execution_packets: executionPackets,
    reduction_receipt: reduceExecutionPackets(executionPackets, 'single_writer'),
    expansion_receipt: reduceExecutionPackets(executionPackets, 'parallel'),
    progress: createProbeProgressTimeline(),
    coordination_telemetry: {
      wall_time_ms: 1200,
      dispatches: 3,
      operational_terminal_failures: 1,
      technical_attempts: 2
    },
    serial_tasks: [
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
    ],
    coordinator_timeline: [
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
    ],
    detail_references: [
      { kind: 'task', id: 'ORC-01', workspace_key: 'folder:probe-workspace' },
      { kind: 'attempt', id: 'attempt-1', workspace_key: 'folder:probe-workspace' },
      { kind: 'finding', id: 'finding-1', workspace_key: 'folder:probe-workspace' },
      { kind: 'cleanup', id: 'cleanup-1', workspace_key: 'folder:probe-workspace' }
    ],
    browser_receipts: [
      browserReceipt('page-visible', 'visible', {
        state: 'released',
        release_receipt: {
          requested: true,
          outcome: 'released',
          exact_page_closed: true,
          profile_affected: false,
          observed_at: '2026-08-24T00:00:00.000Z',
          reason: null
        }
      }),
      browserReceipt('page-offscreen', 'offscreen', {
        state: 'released',
        release_receipt: {
          requested: true,
          outcome: 'released',
          exact_page_closed: true,
          profile_affected: false,
          observed_at: '2026-08-24T00:00:00.000Z',
          reason: null
        }
      })
    ],
    cleanup: {
      live_owned_resources: 0,
      open_browser_pages: 0,
      open_processes: 0,
      user_owned_resources_touched: false,
      unrelated_workspaces_touched: false
    }
  }
}
