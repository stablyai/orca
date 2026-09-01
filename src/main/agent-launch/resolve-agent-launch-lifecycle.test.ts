import { describe, expect, it } from 'vitest'
import type { BuiltInTuiAgent, TuiAgent } from '../../shared/types'
import type {
  AgentLaunchExecutionHostId,
  AgentLaunchSnapshot,
  ResolveAgentLaunchRequest
} from '../../shared/agent-launch-host-contract'
import { resolveAgentLaunch, type ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf,
  tombstone
} from './agent-launch-test-catalog'

type Column =
  | 'interactive-stored'
  | 'live-selection'
  | 'cli'
  | 'unattended'
  | 'resume-with-snapshot'
  | 'resume-without-snapshot'

type Expected =
  | { launch: 'built-in' | 'custom' | 'safe-fallback'; notice?: string }
  | { failure: string }
  | { requestError: string }

const COLUMNS: readonly Column[] = [
  'interactive-stored',
  'live-selection',
  'cli',
  'unattended',
  'resume-with-snapshot',
  'resume-without-snapshot'
]

function snapshotFor(agent: TuiAgent, base: BuiltInTuiAgent): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: agent,
    baseAgent: base,
    displayLabel: 'Snap',
    mode: base === agent ? 'built-in' : 'custom',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

function columnRequest(
  column: Column,
  agent: TuiAgent,
  snapshot: AgentLaunchSnapshot
): ResolveAgentLaunchRequest {
  const base = requestOf({ selection: { kind: 'agent', agent } })
  switch (column) {
    case 'interactive-stored':
      return {
        ...base,
        intent: { kind: 'interactive', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'default' }
      }
    case 'live-selection':
      return {
        ...base,
        intent: { kind: 'interactive', client: 'desktop' },
        reference: { kind: 'live-selection' }
      }
    case 'cli':
      return {
        ...base,
        intent: { kind: 'cli', command: 'worktree-create' },
        reference: { kind: 'direct' }
      }
    case 'unattended':
      return {
        ...base,
        intent: { kind: 'automation', runId: 'r1' },
        reference: { kind: 'persisted', owner: 'automation' }
      }
    case 'resume-with-snapshot':
      return {
        ...base,
        intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'session' },
        persistedSnapshot: snapshot
      }
    case 'resume-without-snapshot':
      return {
        ...base,
        intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'session' }
      }
  }
}

type RowSetup = {
  catalog: ReturnType<typeof catalogOf>
  agent: TuiAgent
  base: BuiltInTuiAgent
}

const CID = customId('claude', '00000000-0000-4000-8000-00000000aaaa')
const CODEX_CID = customId('codex', '00000000-0000-4000-8000-00000000bbbb')
const MISSING_ID = customId('claude', '00000000-0000-4000-8000-00000000cccc')

function setupRow(row: string): RowSetup {
  switch (row) {
    case 'enabled-built-in':
      return { catalog: catalogOf({}), agent: 'claude', base: 'claude' }
    case 'disabled-built-in':
      return {
        catalog: catalogOf({ disabledTuiAgents: ['claude'] }),
        agent: 'claude',
        base: 'claude'
      }
    case 'enabled-custom':
      return {
        catalog: catalogOf({ customTuiAgents: [customAgent({ id: CID })] }),
        agent: CID,
        base: 'claude'
      }
    case 'repair-required':
      return {
        catalog: catalogOf({ customTuiAgents: [customAgent({ id: CID, args: '"unterminated' })] }),
        agent: CID,
        base: 'claude'
      }
    case 'disabled-custom':
      return {
        catalog: catalogOf({
          customTuiAgents: [customAgent({ id: CID })],
          disabledTuiAgents: [CID]
        }),
        agent: CID,
        base: 'claude'
      }
    case 'missing-with-tombstone':
      return {
        catalog: catalogOf({ deletedCustomTuiAgents: [tombstone({ id: CID })] }),
        agent: CID,
        base: 'claude'
      }
    case 'missing-no-tombstone':
      return { catalog: catalogOf({}), agent: MISSING_ID, base: 'claude' }
    case 'base-disabled':
      return {
        catalog: catalogOf({
          customTuiAgents: [customAgent({ id: CODEX_CID, baseAgent: 'codex' })],
          disabledTuiAgents: ['codex']
        }),
        agent: CODEX_CID,
        base: 'codex'
      }
    default:
      throw new Error(`unknown row ${row}`)
  }
}

const TABLE: Record<string, Record<Column, Expected>> = {
  'enabled-built-in': {
    'interactive-stored': { launch: 'built-in' },
    'live-selection': { launch: 'built-in' },
    cli: { launch: 'built-in' },
    unattended: { launch: 'built-in' },
    'resume-with-snapshot': { launch: 'built-in' },
    'resume-without-snapshot': { launch: 'built-in' }
  },
  'disabled-built-in': {
    'interactive-stored': { failure: 'base_agent_disabled' },
    'live-selection': { failure: 'base_agent_disabled' },
    cli: { failure: 'base_agent_disabled' },
    unattended: { failure: 'base_agent_disabled' },
    'resume-with-snapshot': { failure: 'base_agent_disabled' },
    'resume-without-snapshot': { failure: 'base_agent_disabled' }
  },
  'enabled-custom': {
    'interactive-stored': { launch: 'custom' },
    'live-selection': { launch: 'custom' },
    cli: { launch: 'custom' },
    unattended: { launch: 'custom' },
    'resume-with-snapshot': { launch: 'custom' },
    'resume-without-snapshot': { launch: 'custom' }
  },
  'repair-required': {
    'interactive-stored': { failure: 'agent_definition_needs_repair' },
    'live-selection': { failure: 'agent_definition_needs_repair' },
    cli: { failure: 'agent_definition_needs_repair' },
    unattended: { failure: 'agent_definition_needs_repair' },
    'resume-with-snapshot': { launch: 'custom' },
    'resume-without-snapshot': { failure: 'agent_definition_needs_repair' }
  },
  'disabled-custom': {
    'interactive-stored': { launch: 'safe-fallback', notice: 'disabled_custom_fallback' },
    'live-selection': { failure: 'custom_agent_disabled' },
    cli: { failure: 'custom_agent_disabled' },
    unattended: { failure: 'custom_agent_disabled' },
    'resume-with-snapshot': { launch: 'custom' },
    'resume-without-snapshot': { launch: 'safe-fallback', notice: 'disabled_custom_fallback' }
  },
  'missing-with-tombstone': {
    'interactive-stored': { launch: 'safe-fallback', notice: 'missing_custom_fallback' },
    'live-selection': { requestError: 'untrusted_reference' },
    cli: { failure: 'unknown_agent' },
    unattended: { failure: 'unknown_agent' },
    'resume-with-snapshot': { launch: 'custom' },
    'resume-without-snapshot': { launch: 'safe-fallback', notice: 'missing_custom_fallback' }
  },
  'missing-no-tombstone': {
    'interactive-stored': { failure: 'unknown_agent' },
    'live-selection': { failure: 'unknown_agent' },
    cli: { failure: 'unknown_agent' },
    unattended: { failure: 'unknown_agent' },
    'resume-with-snapshot': { launch: 'custom' },
    'resume-without-snapshot': { failure: 'unknown_agent' }
  },
  'base-disabled': {
    'interactive-stored': { failure: 'base_agent_disabled' },
    'live-selection': { failure: 'base_agent_disabled' },
    cli: { failure: 'base_agent_disabled' },
    unattended: { failure: 'base_agent_disabled' },
    'resume-with-snapshot': { failure: 'base_agent_disabled' },
    'resume-without-snapshot': { failure: 'base_agent_disabled' }
  }
}

function assertOutcome(outcome: ResolveAgentLaunchOutcome, expected: Expected): void {
  if ('requestError' in expected) {
    expect(outcome).toEqual({ ok: false, requestError: { code: expected.requestError } })
    return
  }
  if ('failure' in expected) {
    expect(outcome.ok).toBe(false)
    if (!outcome.ok && 'failure' in outcome) {
      expect(outcome.failure.code).toBe(expected.failure)
    } else {
      throw new Error('expected a launch failure, got a request error')
    }
    return
  }
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) {
    throw new Error('expected a successful launch')
  }
  expect(outcome.launch.snapshot.mode).toBe(expected.launch)
  // Oracle 17 mode semantics: used_custom_agent is exactly `mode === 'custom'`
  // (a custom launch stays true even with empty args/env; safe-fallback and
  // built-in are false), and the base kind is always the resolved base's kind —
  // never `other`, since a valid launch always proved a base agent.
  expect(outcome.launch.telemetry.usedCustomAgent).toBe(expected.launch === 'custom')
  expect(outcome.launch.telemetry.agentKind).toBe(
    tuiAgentToAgentKind(outcome.launch.baseAgent)
  )
  expect(outcome.launch.telemetry.agentKind).not.toBe('other')
  // Every launch cell in this table resolves to the stock `claude` argv.
  expect([...outcome.launch.argv]).toEqual(['claude'])
  const noticeCodes = outcome.launch.notices.map((notice) => notice.code)
  if (expected.notice) {
    expect(noticeCodes).toContain(expected.notice)
  }
}

describe('resolveAgentLaunch lifecycle truth table', () => {
  for (const row of Object.keys(TABLE)) {
    for (const column of COLUMNS) {
      it(`${row} × ${column}`, () => {
        const setup = setupRow(row)
        const request = columnRequest(column, setup.agent, snapshotFor(setup.agent, setup.base))
        // Blank the built-in default args so every launch cell resolves to the
        // bare `claude` argv; default-args behavior is covered in the assembly suite.
        const outcome = resolveAgentLaunch(
          request,
          setup.catalog,
          settingsOf({ agentDefaultArgs: { claude: '', codex: '' } })
        )
        assertOutcome(outcome, TABLE[row][column])
      })
    }
  }
})

describe('default selection states', () => {
  it('auto picks first detected effectively-enabled built-in', () => {
    const catalog = catalogOf({ defaultTuiAgent: 'auto' })
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'default' }, detectedStockBaseAgents: new Set(['codex']) }),
      catalog,
      settingsOf()
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.launch.baseAgent).toBe('codex')
      expect(outcome.launch.admissionGuard.basis).toBe('default')
    }
  })

  it('auto with unknown detection tries the first enabled built-in', () => {
    const catalog = catalogOf({ defaultTuiAgent: 'auto' })
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'default' }, detectedStockBaseAgents: null }),
      catalog,
      settingsOf()
    )
    expect(outcome.ok && outcome.launch.baseAgent).toBe('claude')
  })

  it('auto with a concrete empty detection set fails no_agent_selected', () => {
    const catalog = catalogOf({ defaultTuiAgent: 'auto' })
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'default' }, detectedStockBaseAgents: new Set() }),
      catalog,
      settingsOf()
    )
    expect(outcome).toEqual({ ok: false, failure: { code: 'no_agent_selected' } })
  })

  it('blank default fails no_agent_selected', () => {
    const catalog = catalogOf({ defaultTuiAgent: 'blank' })
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'default' } }),
      catalog,
      settingsOf()
    )
    expect(outcome).toEqual({ ok: false, failure: { code: 'no_agent_selected' } })
  })

  it('null default fails no_agent_selected (repair attention)', () => {
    const catalog = catalogOf({ defaultTuiAgent: null })
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'default' } }),
      catalog,
      settingsOf()
    )
    expect(outcome).toEqual({ ok: false, failure: { code: 'no_agent_selected' } })
  })

  it('auto skips a disabled built-in in canonical order', () => {
    const catalog = catalogOf({ defaultTuiAgent: 'auto', disabledTuiAgents: ['claude'] })
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'default' }, detectedStockBaseAgents: null }),
      catalog,
      settingsOf()
    )
    // claude-agent-teams is next in TUI_AGENT_AUTO_PICK_ORDER.
    expect(outcome.ok && outcome.launch.baseAgent).toBe('claude-agent-teams')
  })

  it('explicit stored custom default uses safe fallback when disabled (attended)', () => {
    const catalog = catalogOf({
      customTuiAgents: [customAgent({ id: CID })],
      disabledTuiAgents: [CID],
      defaultTuiAgent: CID
    })
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'default' },
        reference: { kind: 'persisted', owner: 'default' }
      }),
      catalog,
      settingsOf()
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.launch.snapshot.mode).toBe('safe-fallback')
      expect(outcome.launch.requestedAgent).toBe(CID)
      expect(outcome.launch.baseAgent).toBe('claude')
    }
  })
})

describe('resume snapshot validation', () => {
  const goodTarget = {
    platform: 'linux' as NodeJS.Platform,
    executionHostId: 'local' as AgentLaunchExecutionHostId
  }

  it('rejects an identity mismatch', () => {
    const snapshot = snapshotFor('claude', 'claude')
    const outcome = resolveAgentLaunch(
      {
        ...requestOf({ selection: { kind: 'agent', agent: 'codex' }, ...goodTarget }),
        intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'session' },
        persistedSnapshot: snapshot
      },
      catalogOf({}),
      settingsOf()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok && 'failure' in outcome) {
      expect(outcome.failure).toEqual({
        code: 'invalid_launch_snapshot',
        reason: 'identity_mismatch'
      })
    }
  })

  it('rejects a target host mismatch', () => {
    const snapshot = snapshotFor('claude', 'claude')
    const outcome = resolveAgentLaunch(
      {
        ...requestOf({
          selection: { kind: 'agent', agent: 'claude' },
          executionHostId: 'ssh:box' as AgentLaunchExecutionHostId
        }),
        intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'session' },
        persistedSnapshot: snapshot
      },
      catalogOf({}),
      settingsOf()
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok && 'failure' in outcome) {
      expect(outcome.failure.code).toBe('invalid_launch_snapshot')
    }
  })
})
