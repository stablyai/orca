import { describe, expect, it } from 'vitest'
import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  GlobalSettings,
  TerminalAgentQuickCommand
} from '../../shared/types'
import { normalizeAgentCatalog } from '../../shared/custom-tui-agents'
import type { AgentReferenceMutation } from '../../shared/agent-reference-snapshot'
import { applyAgentReferenceMutation } from './agent-reference-mutations'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'

function customId(base: string, uuid = UUID_A): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

function liveAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: customId('codex'),
    baseAgent: 'codex',
    label: 'My Codex',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    defaultTuiAgent: 'auto',
    disabledTuiAgents: [],
    customTuiAgents: [],
    deletedCustomTuiAgents: [],
    agentReferenceRevision: 3,
    terminalQuickCommands: [],
    ...overrides
  } as GlobalSettings
}

function apply(settings: GlobalSettings, mutation: AgentReferenceMutation, expected = 3) {
  const catalog = normalizeAgentCatalog({
    customTuiAgents: settings.customTuiAgents,
    deletedCustomTuiAgents: settings.deletedCustomTuiAgents,
    disabledTuiAgents: settings.disabledTuiAgents,
    defaultTuiAgent: settings.defaultTuiAgent
  }).catalog
  return applyAgentReferenceMutation({
    settings,
    request: { expectedReferenceRevision: expected, mutation },
    currentReferenceRevision: settings.agentReferenceRevision ?? 1,
    catalog
  })
}

function agentQuickCommand(
  overrides: Partial<TerminalAgentQuickCommand> = {}
): TerminalAgentQuickCommand {
  return {
    id: 'qc-1',
    label: 'Fix tests',
    action: 'agent-prompt',
    agent: 'codex',
    prompt: 'fix the tests',
    ...overrides
  }
}

describe('reference revision gating', () => {
  it('rejects a stale expectedReferenceRevision without writing', () => {
    const result = apply(settingsWith(), { kind: 'quick-command-delete', id: 'x' }, 2)
    expect(result).toEqual({ ok: false, code: 'reference_revision_conflict' })
  })
})

describe('quick-command stale-reference write rule', () => {
  const stale = customId('codex', UUID_B) // no live definition, no tombstone needed here
  const storedCommand = agentQuickCommand({ agent: stale })

  it('preserves the exact stored stale reference when resubmitted unchanged', () => {
    const settings = settingsWith({ terminalQuickCommands: [storedCommand] })
    const result = apply(settings, {
      kind: 'quick-command-save',
      command: { ...storedCommand, label: 'Renamed', agent: stale }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const saved = result.patch.terminalQuickCommands?.[0] as TerminalAgentQuickCommand
    expect(saved.label).toBe('Renamed')
    expect(saved.agent).toBe(stale)
    expect(result.patch.agentReferenceRevision).toBe(4)
  })

  it('rejects a changed agent that is not a current enabled live identity', () => {
    const settings = settingsWith({ terminalQuickCommands: [storedCommand] })
    const unknown = apply(settings, {
      kind: 'quick-command-save',
      command: { ...storedCommand, agent: customId('claude', UUID_A) }
    })
    expect(unknown).toMatchObject({
      ok: false,
      code: 'invalid_agent_reference',
      owner: 'quick-command',
      reason: 'unknown_agent'
    })

    const live = liveAgent()
    const disabledSettings = settingsWith({
      terminalQuickCommands: [storedCommand],
      customTuiAgents: [live],
      disabledTuiAgents: [live.id]
    })
    const disabled = apply(disabledSettings, {
      kind: 'quick-command-save',
      command: { ...storedCommand, agent: live.id }
    })
    expect(disabled).toMatchObject({ ok: false, reason: 'disabled_agent' })

    const baseDisabledSettings = settingsWith({
      terminalQuickCommands: [storedCommand],
      customTuiAgents: [live],
      disabledTuiAgents: ['codex']
    })
    const baseDisabled = apply(baseDisabledSettings, {
      kind: 'quick-command-save',
      command: { ...storedCommand, agent: live.id }
    })
    expect(baseDisabled).toMatchObject({ ok: false, reason: 'disabled_agent' })
  })

  it('accepts a changed agent that is an enabled live identity', () => {
    const live = liveAgent()
    const settings = settingsWith({
      terminalQuickCommands: [storedCommand],
      customTuiAgents: [live]
    })
    const result = apply(settings, {
      kind: 'quick-command-save',
      command: { ...storedCommand, agent: live.id }
    })
    expect(result.ok).toBe(true)
  })

  it('rejects an agent whose base cannot run agent-prompt quick commands', () => {
    // Normalization silently drops stdin-after-start rows, so the save must
    // fail typed instead of returning ok while the command vanishes.
    const builtIn = apply(settingsWith(), {
      kind: 'quick-command-save',
      command: agentQuickCommand({ agent: 'ante' })
    })
    expect(builtIn).toMatchObject({
      ok: false,
      code: 'invalid_agent_reference',
      owner: 'quick-command',
      reason: 'unknown_agent'
    })

    const derivative = liveAgent({ id: customId('ante'), baseAgent: 'ante', label: 'My Ante' })
    const custom = apply(settingsWith({ customTuiAgents: [derivative] }), {
      kind: 'quick-command-save',
      command: agentQuickCommand({ agent: derivative.id })
    })
    expect(custom).toMatchObject({
      ok: false,
      code: 'invalid_agent_reference',
      owner: 'quick-command',
      reason: 'unknown_agent'
    })
  })

  it('a new row cannot mint fallback authority from a stale id', () => {
    // The same stale id that is preserved on its own row is rejected when a
    // client echoes it into a different/new row.
    const settings = settingsWith({ terminalQuickCommands: [storedCommand] })
    const result = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ id: 'qc-new', agent: stale })
    })
    expect(result).toMatchObject({ ok: false, reason: 'unknown_agent' })
  })

  it('deletes and reorders without touching agent references', () => {
    const other = agentQuickCommand({ id: 'qc-2', agent: 'claude' })
    const settings = settingsWith({ terminalQuickCommands: [storedCommand, other] })
    const removed = apply(settings, { kind: 'quick-command-delete', id: 'qc-1' })
    expect(removed.ok).toBe(true)
    if (!removed.ok) {
      return
    }
    expect(removed.patch.terminalQuickCommands).toEqual([other])

    const reordered = apply(settings, {
      kind: 'quick-commands-reorder',
      orderedIds: ['qc-2', 'qc-1']
    })
    expect(reordered.ok).toBe(true)
    if (!reordered.ok) {
      return
    }
    expect(reordered.patch.terminalQuickCommands?.map((command) => command.id)).toEqual([
      'qc-2',
      'qc-1'
    ])

    const badReorder = apply(settings, {
      kind: 'quick-commands-reorder',
      orderedIds: ['qc-2']
    })
    expect(badReorder).toMatchObject({ ok: false, code: 'invalid_reference_field' })
  })
})

describe('commit-message and source-control field-level rule', () => {
  const stale = customId('codex', UUID_B)

  it('preserves a stored stale agentId when omitted or resubmitted; clears explicitly', () => {
    const settings = settingsWith({
      commitMessageAi: {
        enabled: true,
        agentId: stale,
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customPrompt: '',
        customAgentCommand: ''
      }
    })
    const omitted = apply(settings, {
      kind: 'commit-message-update',
      changes: { enabled: false }
    })
    expect(omitted.ok).toBe(true)
    if (!omitted.ok) {
      return
    }
    expect(omitted.patch.commitMessageAi?.agentId).toBe(stale)
    expect(omitted.patch.commitMessageAi?.enabled).toBe(false)

    const resubmitted = apply(settings, {
      kind: 'commit-message-update',
      changes: { agentId: stale }
    })
    expect(resubmitted.ok).toBe(true)

    const cleared = apply(settings, {
      kind: 'commit-message-update',
      changes: { agentId: null }
    })
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) {
      return
    }
    expect(cleared.patch.commitMessageAi?.agentId).toBeNull()
  })

  it('allows the custom-command sentinel and enabled identities; rejects unknown ids', () => {
    const settings = settingsWith({
      commitMessageAi: {
        enabled: true,
        agentId: null,
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customPrompt: '',
        customAgentCommand: ''
      }
    })
    expect(
      apply(settings, { kind: 'commit-message-update', changes: { agentId: 'custom' } }).ok
    ).toBe(true)
    expect(
      apply(settings, { kind: 'commit-message-update', changes: { agentId: 'claude' } }).ok
    ).toBe(true)
    expect(
      apply(settings, { kind: 'commit-message-update', changes: { agentId: stale } })
    ).toMatchObject({ ok: false, reason: 'unknown_agent' })
  })

  it('applies the row-level rule to source-control action recipes', () => {
    const live = liveAgent()
    const settings = settingsWith({
      customTuiAgents: [live],
      sourceControlAi: {
        enabled: true,
        agentId: null,
        actions: {
          'commit-message': { agentId: stale, commandInputTemplate: 'x' }
        },
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customAgentCommand: '',
        instructionsByOperation: {}
      } as GlobalSettings['sourceControlAi']
    })
    // Unrelated action field saves while the stale row reference is preserved.
    const preserved = apply(settings, {
      kind: 'source-control-update',
      changes: {
        actions: { 'commit-message': { commandInputTemplate: 'y' } }
      } as Partial<NonNullable<GlobalSettings['sourceControlAi']>>
    })
    expect(preserved.ok).toBe(true)
    if (!preserved.ok) {
      return
    }
    const action = preserved.patch.sourceControlAi?.actions?.['commit-message'] as {
      agentId?: unknown
      commandInputTemplate?: unknown
    }
    expect(action.agentId).toBe(stale)
    expect(action.commandInputTemplate).toBe('y')

    // Changing the row to a live enabled identity works; unknown is rejected.
    const changed = apply(settings, {
      kind: 'source-control-update',
      changes: {
        actions: { 'commit-message': { agentId: live.id } }
      } as Partial<NonNullable<GlobalSettings['sourceControlAi']>>
    })
    expect(changed.ok).toBe(true)

    const rejected = apply(settings, {
      kind: 'source-control-update',
      changes: {
        actions: { 'commit-message': { agentId: customId('claude', UUID_A) } }
      } as Partial<NonNullable<GlobalSettings['sourceControlAi']>>
    })
    expect(rejected).toMatchObject({ ok: false, owner: 'source-control-recipe' })
  })

  it('ignores prototype keys in the incoming actions record', () => {
    const settings = settingsWith({
      sourceControlAi: {
        enabled: true,
        agentId: null,
        actions: {},
        selectedModelByAgent: {},
        selectedThinkingByModel: {},
        customAgentCommand: '',
        instructionsByOperation: {}
      } as GlobalSettings['sourceControlAi']
    })
    const result = apply(settings, {
      kind: 'source-control-update',
      changes: {
        actions: JSON.parse('{"__proto__": {"agentId": "claude"}}') as Record<string, unknown>
      } as Partial<NonNullable<GlobalSettings['sourceControlAi']>>
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const actions = result.patch.sourceControlAi?.actions ?? {}
    // The merged record must keep the plain-object prototype and stay empty.
    expect(Object.getPrototypeOf(actions)).toBe(Object.prototype)
    expect(Object.keys(actions)).toEqual([])
  })
})

describe('quick-command persisted-as-sent bounds (L1-#3)', () => {
  it('rejects the save that would exceed the 40-command cap instead of silently dropping it', () => {
    const commands = Array.from({ length: 40 }, (_, index) =>
      agentQuickCommand({ id: `qc-${index}`, label: `Cmd ${index}` })
    )
    const settings = settingsWith({ terminalQuickCommands: commands })
    const result = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ id: 'qc-overflow' })
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_reference_field',
      owner: 'quick-command',
      field: 'count',
      reason: 'bounds'
    })
  })

  it('still saves an update to an existing command at the 40-command cap', () => {
    const commands = Array.from({ length: 40 }, (_, index) =>
      agentQuickCommand({ id: `qc-${index}`, label: `Cmd ${index}` })
    )
    const settings = settingsWith({ terminalQuickCommands: commands })
    const result = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ id: 'qc-3', label: 'Renamed' })
    })
    expect(result.ok).toBe(true)
  })

  it('rejects labels, ids, prompts, and terminal commands past the normalization truncation caps', () => {
    const settings = settingsWith()
    const longLabel = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ label: 'x'.repeat(81) })
    })
    expect(longLabel).toMatchObject({ ok: false, field: 'label', reason: 'bounds' })

    const longId = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ id: 'x'.repeat(81) })
    })
    expect(longId).toMatchObject({ ok: false, field: 'label', reason: 'bounds' })

    const longPrompt = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ prompt: 'x'.repeat(6001) })
    })
    expect(longPrompt).toMatchObject({ ok: false, field: 'prompt', reason: 'bounds' })

    const longCommand = apply(settings, {
      kind: 'quick-command-save',
      command: {
        id: 'qc-term',
        label: 'Term',
        action: 'terminal-command' as const,
        command: 'x'.repeat(4001),
        appendEnter: true
      }
    })
    expect(longCommand).toMatchObject({ ok: false, field: 'command', reason: 'bounds' })

    // Boundary values persist as sent.
    const atCap = apply(settings, {
      kind: 'quick-command-save',
      command: agentQuickCommand({ label: 'x'.repeat(80), prompt: 'y'.repeat(6000) })
    })
    expect(atCap.ok).toBe(true)
  })
})

describe('malformed mutation payloads return typed errors (L1-#6)', () => {
  it('rejects null commit-message changes without throwing', () => {
    const result = apply(settingsWith(), {
      kind: 'commit-message-update',
      changes: null as unknown as Record<string, never>
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_reference_field',
      owner: 'commit-message',
      reason: 'bounds'
    })
  })

  it('rejects null source-control changes and a non-record actions map without throwing', () => {
    const nullChanges = apply(settingsWith(), {
      kind: 'source-control-update',
      changes: null as unknown as Record<string, never>
    })
    expect(nullChanges).toMatchObject({
      ok: false,
      code: 'invalid_reference_field',
      owner: 'source-control-recipe',
      reason: 'bounds'
    })

    const stringActions = apply(settingsWith(), {
      kind: 'source-control-update',
      changes: { actions: 'garbage' } as unknown as Partial<
        NonNullable<GlobalSettings['sourceControlAi']>
      >
    })
    expect(stringActions).toMatchObject({
      ok: false,
      code: 'invalid_reference_field',
      owner: 'source-control-recipe',
      reason: 'bounds'
    })
  })

  it('rejects a non-array reorder payload without throwing', () => {
    const settings = settingsWith({ terminalQuickCommands: [agentQuickCommand()] })
    const result = apply(settings, {
      kind: 'quick-commands-reorder',
      orderedIds: 'qc-1' as unknown as string[]
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_reference_field',
      owner: 'quick-command',
      reason: 'conflict'
    })
  })
})
