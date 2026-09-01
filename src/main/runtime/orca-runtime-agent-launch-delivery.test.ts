// Post-ready prompt delivery for host-spawned agent terminals. A host-spawned
// terminal (created-worktree OR a background terminal-create) has no renderer
// writer armed, so the host must deliver stdin-after-start (followupPrompt) and
// no-native-affordance draft (draftPrompt) prompts itself through one shared
// writer (deliverTerminalLaunchPrompt); command-deliverable modes carry no
// post-ready text. This exercises only the delivery routing — the readiness
// writers' internal polling/paste is unit-tested separately.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { ResolvedTerminalPostReadyPrompt } from './terminal-agent-launch-resolution'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type { AgentLaunchReceipt } from '../../shared/agent-launch-contract'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type DeliveryInternals = {
  deliverWorktreeAgentLaunchPrompt: (
    handle: string,
    plan: AgentStartupPlan,
    receipt: AgentLaunchReceipt
  ) => void
  deliverTerminalLaunchPrompt: (
    handle: string,
    baseAgent: string,
    postReady: ResolvedTerminalPostReadyPrompt
  ) => void
  sendStartupFollowupWhenReady: (handle: string, followup: unknown) => void
  pasteStartupDraftWhenReady: (handle: string, draft: unknown) => void
}

// A custom requested agent whose base is a built-in — proves the draft ready
// signal keys off the base agent (custom ids are not in TUI_AGENT_CONFIG).
const RECEIPT: AgentLaunchReceipt = {
  requestedAgent: 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd',
  baseAgent: 'codex',
  notices: [],
  launchToken: 'tok-1',
  catalogRevision: 1,
  telemetry: { agentKind: 'codex', usedCustomAgent: true }
}

function basePlan(overrides: Partial<AgentStartupPlan>): AgentStartupPlan {
  return {
    agent: RECEIPT.requestedAgent,
    launchCommand: 'codex',
    expectedProcess: 'codex',
    followupPrompt: null,
    launchConfig: { agentArgs: '', agentEnv: {} },
    ...overrides
  }
}

function armDeliverySpies(runtime: OrcaRuntimeService): {
  internals: DeliveryInternals
  followup: ReturnType<typeof vi.fn>
  draft: ReturnType<typeof vi.fn>
} {
  const internals = runtime as unknown as DeliveryInternals
  const followup = vi.fn()
  const draft = vi.fn()
  internals.sendStartupFollowupWhenReady = followup
  internals.pasteStartupDraftWhenReady = draft
  return { internals, followup, draft }
}

describe('deliverWorktreeAgentLaunchPrompt', () => {
  it('submits a stdin-after-start followup prompt with the resolved expected process', () => {
    const runtime = new OrcaRuntimeService()
    const { internals, followup, draft } = armDeliverySpies(runtime)

    internals.deliverWorktreeAgentLaunchPrompt(
      'term-1',
      basePlan({ followupPrompt: 'do the thing' }),
      RECEIPT
    )

    expect(followup).toHaveBeenCalledWith('term-1', {
      expectedProcess: 'codex',
      prompt: 'do the thing'
    })
    expect(draft).not.toHaveBeenCalled()
  })

  it('pastes a no-affordance draft unsubmitted, keyed off the base agent', () => {
    const runtime = new OrcaRuntimeService()
    const { internals, followup, draft } = armDeliverySpies(runtime)

    internals.deliverWorktreeAgentLaunchPrompt(
      'term-2',
      basePlan({ draftPrompt: 'draft body' }),
      RECEIPT
    )

    // Keyed off the base agent (codex), NOT the custom requestedAgent id.
    expect(draft).toHaveBeenCalledWith('term-2', { agent: 'codex', content: 'draft body' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('delivers nothing for a command-deliverable plan (argv/flag/env prompt)', () => {
    const runtime = new OrcaRuntimeService()
    const { internals, followup, draft } = armDeliverySpies(runtime)

    internals.deliverWorktreeAgentLaunchPrompt(
      'term-3',
      basePlan({ launchCommand: 'codex --prompt "inline"' }),
      RECEIPT
    )

    expect(followup).not.toHaveBeenCalled()
    expect(draft).not.toHaveBeenCalled()
  })
})

// The extracted shared writer the background terminal-create path uses directly
// (worktree-create delegates to it). Same routing contract, keyed off the base
// agent + resolved post-ready prompt rather than a full startup plan.
describe('deliverTerminalLaunchPrompt', () => {
  it('submits a stdin-after-start followup with the resolved expected process', () => {
    const runtime = new OrcaRuntimeService()
    const { internals, followup, draft } = armDeliverySpies(runtime)

    internals.deliverTerminalLaunchPrompt('term-1', 'codex', {
      expectedProcess: 'codex',
      followupPrompt: 'do the thing'
    })

    expect(followup).toHaveBeenCalledWith('term-1', {
      expectedProcess: 'codex',
      prompt: 'do the thing'
    })
    expect(draft).not.toHaveBeenCalled()
  })

  it('pastes a no-affordance draft unsubmitted, keyed off the passed base agent', () => {
    const runtime = new OrcaRuntimeService()
    const { internals, followup, draft } = armDeliverySpies(runtime)

    internals.deliverTerminalLaunchPrompt('term-2', 'codex', {
      expectedProcess: 'codex',
      draftPrompt: 'draft body'
    })

    expect(draft).toHaveBeenCalledWith('term-2', { agent: 'codex', content: 'draft body' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('delivers nothing when neither followup nor draft text is present', () => {
    const runtime = new OrcaRuntimeService()
    const { internals, followup, draft } = armDeliverySpies(runtime)

    internals.deliverTerminalLaunchPrompt('term-3', 'codex', { expectedProcess: 'codex' })

    expect(followup).not.toHaveBeenCalled()
    expect(draft).not.toHaveBeenCalled()
  })
})

// Option A (host-emits-on-create): the create spawn threads the receipt's
// host-derived kind + used_custom_agent plus the surface fields into the terminal
// spawn ONLY for an interactive create — the host emits agent_started at the
// registered PTY. An unattended create passes no surface telemetry and emits
// nothing.
describe('spawnWorktreeAgentLaunchTerminal agent_started threading', () => {
  type SpawnInternals = {
    spawnWorktreeAgentLaunchTerminal: (
      worktreeId: string,
      plan: AgentStartupPlan,
      receipt: AgentLaunchReceipt,
      surfaceTelemetry?: { launch_source: string; request_kind: string }
    ) => Promise<{ terminalId: string }>
    createTerminal: (worktreeId: string, opts: { telemetry?: unknown }) => Promise<{ handle: string }>
    deliverWorktreeAgentLaunchPrompt: (...args: unknown[]) => void
  }

  function armSpawn(runtime: OrcaRuntimeService): {
    internals: SpawnInternals
    createTerminal: ReturnType<typeof vi.fn>
  } {
    const internals = runtime as unknown as SpawnInternals
    const createTerminal = vi.fn(async () => ({ handle: 'term-create' }))
    internals.createTerminal = createTerminal as never
    // Stub post-ready delivery and receipt bookkeeping side effects so the test
    // isolates the telemetry-threading decision.
    internals.deliverWorktreeAgentLaunchPrompt = vi.fn()
    return { internals, createTerminal }
  }

  it('threads host kind + used_custom_agent with surface fields for an interactive create', async () => {
    const runtime = new OrcaRuntimeService()
    const { internals, createTerminal } = armSpawn(runtime)

    await internals.spawnWorktreeAgentLaunchTerminal('wt-1', basePlan({}), RECEIPT, {
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    })

    const opts = createTerminal.mock.calls[0]![1] as { telemetry?: unknown }
    expect(opts.telemetry).toEqual({
      agent_kind: 'codex',
      launch_source: 'new_workspace_composer',
      request_kind: 'new',
      used_custom_agent: true
    })
  })

  it('omits telemetry for an unattended create (no host emit)', async () => {
    const runtime = new OrcaRuntimeService()
    const { internals, createTerminal } = armSpawn(runtime)

    await internals.spawnWorktreeAgentLaunchTerminal('wt-2', basePlan({}), RECEIPT)

    const opts = createTerminal.mock.calls[0]![1] as { telemetry?: unknown }
    expect(opts.telemetry).toBeUndefined()
  })
})
