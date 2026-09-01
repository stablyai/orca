import { describe, expect, it } from 'vitest'
import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings
} from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import {
  AgentCatalogRepairTokenRegistry,
  applyAgentCatalogMutation,
  type ApplyAgentCatalogMutationArgs
} from './agent-catalog-mutations'

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

function draft(overrides: Partial<CustomAgentDraft> = {}): CustomAgentDraft {
  return {
    label: 'New Agent',
    commandOverride: null,
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
    agentCatalogRevision: 5,
    agentCmdOverrides: {},
    ...overrides
  } as GlobalSettings
}

function apply(
  overrides: Partial<ApplyAgentCatalogMutationArgs> & {
    mutation: ApplyAgentCatalogMutationArgs['request']['mutation']
    expectedRevision?: number
  }
) {
  const { mutation, expectedRevision, ...rest } = overrides
  return applyAgentCatalogMutation({
    settings: settingsWith(),
    currentRevision: 5,
    repairTokens: new AgentCatalogRepairTokenRegistry(),
    countTombstoneReferences: () => 0,
    ...rest,
    request: { expectedRevision: expectedRevision ?? 5, mutation }
  })
}

describe('revision gating', () => {
  it('rejects a stale expectedRevision without writing', () => {
    const result = apply({
      mutation: { kind: 'create', baseAgent: 'codex', draft: draft() },
      expectedRevision: 4
    })
    expect(result).toEqual({ ok: false, code: 'catalog_revision_conflict' })
  })
})

describe('create', () => {
  it('mints a canonical id and appends in creation order', () => {
    const existing = liveAgent({ label: 'Existing' })
    const result = apply({
      settings: settingsWith({ customTuiAgents: [existing] }),
      mutation: { kind: 'create', baseAgent: 'claude', draft: draft() }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.newRevision).toBe(6)
    const live = result.patch.customTuiAgents ?? []
    expect(live).toHaveLength(2)
    expect(live[0].label).toBe('Existing')
    expect(live[1].id).toBe(result.mintedId)
    expect(live[1].baseAgent).toBe('claude')
    expect(result.patch.agentCatalogRevision).toBe(6)
  })

  it('rejects invalid drafts with field/reason metadata', () => {
    const cases: {
      draft: CustomAgentDraft
      field: string
      reason: string
      envEntryIndex?: number
    }[] = [
      { draft: draft({ label: '' }), field: 'label', reason: 'empty' },
      { draft: draft({ label: 'x'.repeat(81) }), field: 'label', reason: 'bounds' },
      {
        draft: draft({ commandOverride: 'codex && evil' }),
        field: 'commandOverride',
        reason: 'shell_operator'
      },
      {
        draft: draft({ commandOverride: '"unclosed' }),
        field: 'commandOverride',
        reason: 'unterminated_quote'
      },
      { draft: draft({ args: '"a\nb"' }), field: 'args', reason: 'quoted_line_break' },
      { draft: draft({ args: '"open' }), field: 'args', reason: 'unterminated_quote' },
      { draft: draft({ args: 'x'.repeat(8193) }), field: 'args', reason: 'bounds' },
      {
        draft: draft({ env: { ORCA_EVIL: 'x' } }),
        field: 'env',
        reason: 'reserved_name',
        envEntryIndex: 0
      },
      {
        draft: draft({ env: JSON.parse('{"__proto__": "x"}') as Record<string, string> }),
        field: 'env',
        reason: 'prototype_key',
        envEntryIndex: 0
      },
      {
        draft: draft({ env: { Path: 'a', PATH: 'b' } }),
        field: 'env',
        reason: 'case_collision',
        envEntryIndex: 1
      }
    ]
    for (const testCase of cases) {
      const result = apply({
        mutation: { kind: 'create', baseAgent: 'codex', draft: testCase.draft }
      })
      expect(result.ok).toBe(false)
      if (result.ok) {
        continue
      }
      expect(result.code).toBe('invalid_agent_field')
      expect(result.field).toBe(testCase.field)
      expect(result.reason).toBe(testCase.reason)
      if (testCase.envEntryIndex !== undefined) {
        expect(result.envEntryIndex).toBe(testCase.envEntryIndex)
      }
    }
  })

  it('rejects the 16 KiB aggregate env bound', () => {
    const env: Record<string, string> = {}
    for (let i = 0; i < 5; i += 1) {
      env[`K${i}`] = 'v'.repeat(4000)
    }
    const result = apply({
      mutation: { kind: 'create', baseAgent: 'codex', draft: draft({ env }) }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'env',
      reason: 'env_total_bounds'
    })
  })

  it('accepts multiline args (the editor is real, not cosmetic)', () => {
    const result = apply({
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: draft({ args: '--model x\n--safe "two words"' })
      }
    })
    expect(result.ok).toBe(true)
  })

  it('normalizes CRLF to LF on save', () => {
    const result = apply({
      mutation: {
        kind: 'create',
        baseAgent: 'codex',
        draft: draft({ args: '--a\r\n--b' })
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.customTuiAgents?.[0].args).toBe('--a\n--b')
  })

  it('rejects label collisions with built-in canonical names, live labels, and referenced tombstones', () => {
    const live = liveAgent({ label: 'Mine' })
    const tombstone: DeletedCustomTuiAgent = {
      id: customId('claude', UUID_B),
      baseAgent: 'claude',
      label: 'Kept Name',
      deletedAt: 1
    }
    const settings = settingsWith({
      customTuiAgents: [live],
      deletedCustomTuiAgents: [tombstone]
    })
    for (const label of ['Codex', ' codex ', 'MINE', 'kept name']) {
      const result = apply({
        settings,
        countTombstoneReferences: () => 1,
        mutation: { kind: 'create', baseAgent: 'codex', draft: draft({ label }) }
      })
      expect(result).toMatchObject({ ok: false, code: 'duplicate_agent_label' })
    }
  })

  it('prunes unreferenced tombstones before label validation, freeing the name', () => {
    const tombstone: DeletedCustomTuiAgent = {
      id: customId('claude', UUID_B),
      baseAgent: 'claude',
      label: 'Freed Name',
      deletedAt: 1
    }
    const result = apply({
      settings: settingsWith({ deletedCustomTuiAgents: [tombstone] }),
      countTombstoneReferences: () => 0,
      mutation: { kind: 'create', baseAgent: 'codex', draft: draft({ label: 'Freed Name' }) }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.prunedTombstoneIds).toEqual([tombstone.id])
    expect(result.patch.deletedCustomTuiAgents).toEqual([])
  })

  it('retains tombstones when a reference scan is unknown', () => {
    const tombstone: DeletedCustomTuiAgent = {
      id: customId('claude', UUID_B),
      baseAgent: 'claude',
      label: 'Retained Name',
      deletedAt: 1
    }
    const result = apply({
      settings: settingsWith({ deletedCustomTuiAgents: [tombstone] }),
      countTombstoneReferences: () => 'unknown',
      mutation: { kind: 'create', baseAgent: 'codex', draft: draft({ label: 'Retained Name' }) }
    })
    expect(result).toMatchObject({ ok: false, code: 'duplicate_agent_label' })
  })
})

describe('duplicate', () => {
  it('duplicates a disabled live custom into an enabled copy with syncEnv false', () => {
    const source = liveAgent({
      label: 'Source',
      commandOverride: '/opt/codex',
      args: '--model x',
      env: { FOO: 'bar' },
      syncEnv: true
    })
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [source],
        disabledTuiAgents: [source.id]
      }),
      mutation: { kind: 'duplicate', sourceAgent: source.id, label: 'Copy' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const copy = result.patch.customTuiAgents?.find((agent) => agent.id === result.mintedId)
    expect(copy).toMatchObject({
      label: 'Copy',
      baseAgent: 'codex',
      commandOverride: '/opt/codex',
      args: '--model x',
      env: { FOO: 'bar' },
      syncEnv: false
    })
    // Enabled copy: the disabled list is untouched (the new id is not added).
    expect(result.patch.disabledTuiAgents).toBeUndefined()
  })

  it('never duplicates from a tombstone', () => {
    const tombstone: DeletedCustomTuiAgent = {
      id: customId('codex'),
      baseAgent: 'codex',
      label: 'Gone',
      deletedAt: 1
    }
    const result = apply({
      settings: settingsWith({ deletedCustomTuiAgents: [tombstone] }),
      mutation: { kind: 'duplicate', sourceAgent: tombstone.id, label: 'Copy' }
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_agent_field' })
  })

  it('splits an unambiguous multi-token built-in prefix into executable + prepended args', () => {
    const result = apply({
      settings: settingsWith({
        agentCmdOverrides: { codex: '/opt/wrap codex-real --fast' },
        agentDefaultArgs: { codex: '--user-arg' }
      }),
      mutation: { kind: 'duplicate', sourceAgent: 'codex', label: 'Wrapped' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const copy = result.patch.customTuiAgents?.[0]
    expect(copy?.commandOverride).toBe('/opt/wrap')
    expect(copy?.args).toBe('codex-real --fast --user-arg')
  })

  it('keeps a grouped prefix argument grouped instead of flattening it into two args', () => {
    const result = apply({
      settings: settingsWith({
        agentCmdOverrides: { codex: '/opt/wrap --prompt "hello world"' },
        agentDefaultArgs: { codex: '--user-arg' }
      }),
      mutation: { kind: 'duplicate', sourceAgent: 'codex', label: 'Wrapped' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const copy = result.patch.customTuiAgents?.[0]
    expect(copy?.commandOverride).toBe('/opt/wrap')
    // A bare join would store `--prompt hello world`, which re-splits into three.
    expect(copy?.args).toBe('--prompt "hello world" --user-arg')
    for (const shell of ['posix', 'powershell', 'cmd'] as const) {
      const tokenized = tokenizeStartupCommand(copy?.args ?? '', shell)
      expect(tokenized.ok && tokenized.tokens).toEqual(['--prompt', 'hello world', '--user-arg'])
    }
  })

  it('rejects a platform-ambiguous built-in prefix instead of guessing a grammar', () => {
    const result = apply({
      settings: settingsWith({
        agentCmdOverrides: { codex: 'C:\\tools\\wrap.exe codex' }
      }),
      mutation: { kind: 'duplicate', sourceAgent: 'codex', label: 'Wrapped' }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'commandOverride',
      reason: 'platform_ambiguous'
    })
  })
})

describe('update-custom', () => {
  it('updates in place, preserving physical index', () => {
    const first = liveAgent({ id: customId('codex', UUID_A), label: 'First' })
    const second = liveAgent({
      id: customId('claude', UUID_B),
      baseAgent: 'claude',
      label: 'Second'
    })
    const result = apply({
      settings: settingsWith({ customTuiAgents: [first, second] }),
      mutation: {
        kind: 'update-custom',
        id: first.id,
        changes: {
          label: 'First Renamed',
          commandOverride: null,
          args: '--new',
          env: { A: '1' },
          syncEnv: true
        }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const live = result.patch.customTuiAgents ?? []
    expect(live[0]).toMatchObject({ id: first.id, label: 'First Renamed', syncEnv: true })
    expect(live[1]).toMatchObject({ id: second.id, label: 'Second' })
  })

  it('repairs a valid-unique-id repair-required row through update-custom', () => {
    const broken = { ...liveAgent(), label: '' }
    const result = apply({
      settings: settingsWith({ customTuiAgents: [broken] }),
      mutation: {
        kind: 'update-custom',
        id: broken.id,
        changes: { label: 'Fixed', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.customTuiAgents?.[0]).toMatchObject({ id: broken.id, label: 'Fixed' })
  })

  it('rejects updates for unknown ids', () => {
    const result = apply({
      mutation: {
        kind: 'update-custom',
        id: customId('codex', UUID_B),
        changes: { label: 'X', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_agent_field' })
  })

  it('allows keeping its own label without a false collision', () => {
    const live = liveAgent({ label: 'Keep Me' })
    const result = apply({
      settings: settingsWith({ customTuiAgents: [live] }),
      mutation: {
        kind: 'update-custom',
        id: live.id,
        changes: { label: 'keep me', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(result.ok).toBe(true)
  })
})

describe('delete-custom', () => {
  const live = liveAgent({ label: 'Doomed', args: '--secret', env: { KEY: 'value' } })

  it('tombstones id/base/label only, removes the live row and disabled entry, and strips model caches', () => {
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [live],
        disabledTuiAgents: [live.id, 'gemini'],
        sourceControlAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: { [live.id]: 'model-x', codex: 'model-y' },
          selectedThinkingByModel: {},
          customAgentCommand: '',
          instructionsByOperation: {}
        } as GlobalSettings['sourceControlAi'],
        commitMessageAi: {
          enabled: true,
          agentId: null,
          selectedModelByAgent: { [live.id]: 'model-z' },
          selectedThinkingByModel: {},
          customPrompt: '',
          customAgentCommand: ''
        } as GlobalSettings['commitMessageAi']
      }),
      mutation: { kind: 'delete-custom', id: live.id }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.customTuiAgents).toEqual([])
    const tombstone = result.patch.deletedCustomTuiAgents?.[0]
    expect(tombstone).toMatchObject({ id: live.id, baseAgent: 'codex', label: 'Doomed' })
    // Tombstones never carry recoverable config.
    expect(tombstone && 'args' in tombstone).toBe(false)
    expect(tombstone && 'env' in tombstone).toBe(false)
    expect(result.patch.disabledTuiAgents).toEqual(['gemini'])
    expect(result.patch.sourceControlAi?.selectedModelByAgent).toEqual({ codex: 'model-y' })
    expect(result.patch.commitMessageAi?.selectedModelByAgent).toEqual({})
  })

  it('applies onDefault only when the deleted id is the current default', () => {
    const notDefault = apply({
      settings: settingsWith({ customTuiAgents: [live], defaultTuiAgent: 'codex' }),
      mutation: { kind: 'delete-custom', id: live.id, onDefault: 'clear' }
    })
    expect(notDefault.ok).toBe(true)
    if (!notDefault.ok) {
      return
    }
    expect('defaultTuiAgent' in notDefault.patch).toBe(false)

    const keep = apply({
      settings: settingsWith({ customTuiAgents: [live], defaultTuiAgent: live.id }),
      mutation: { kind: 'delete-custom', id: live.id, onDefault: 'keep' }
    })
    expect(keep.ok).toBe(true)
    if (!keep.ok) {
      return
    }
    expect('defaultTuiAgent' in keep.patch).toBe(false)

    for (const [onDefault, expected] of [
      ['base', 'codex'],
      ['auto', 'auto'],
      ['clear', null]
    ] as const) {
      const result = apply({
        settings: settingsWith({ customTuiAgents: [live], defaultTuiAgent: live.id }),
        mutation: { kind: 'delete-custom', id: live.id, onDefault }
      })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        continue
      }
      expect(result.patch.defaultTuiAgent).toBe(expected)
    }
  })

  it('treats onDefault base as clear when the base is disabled', () => {
    const result = apply({
      settings: settingsWith({
        customTuiAgents: [live],
        defaultTuiAgent: live.id,
        disabledTuiAgents: ['codex']
      }),
      mutation: { kind: 'delete-custom', id: live.id, onDefault: 'base' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.defaultTuiAgent).toBeNull()
  })
})

describe('set-enabled', () => {
  it('disables and re-enables known identities in one write each', () => {
    const live = liveAgent()
    const disable = apply({
      settings: settingsWith({ customTuiAgents: [live] }),
      mutation: { kind: 'set-enabled', agent: live.id, enabled: false }
    })
    expect(disable.ok).toBe(true)
    if (!disable.ok) {
      return
    }
    expect(disable.patch.disabledTuiAgents).toEqual([live.id])

    const enable = apply({
      settings: settingsWith({ customTuiAgents: [live], disabledTuiAgents: [live.id] }),
      mutation: { kind: 'set-enabled', agent: live.id, enabled: true }
    })
    expect(enable.ok).toBe(true)
    if (!enable.ok) {
      return
    }
    expect(enable.patch.disabledTuiAgents).toEqual([])
  })

  it('keeps a disabled custom default as the stored reference', () => {
    const live = liveAgent()
    const result = apply({
      settings: settingsWith({ customTuiAgents: [live], defaultTuiAgent: live.id }),
      mutation: { kind: 'set-enabled', agent: live.id, enabled: false }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect('defaultTuiAgent' in result.patch).toBe(false)
  })

  it('disabling a base repairs a base or derivative default to null in the same write', () => {
    const live = liveAgent()
    const derivative = apply({
      settings: settingsWith({ customTuiAgents: [live], defaultTuiAgent: live.id }),
      mutation: { kind: 'set-enabled', agent: 'codex', enabled: false }
    })
    expect(derivative.ok).toBe(true)
    if (!derivative.ok) {
      return
    }
    expect(derivative.patch.defaultTuiAgent).toBeNull()

    const builtIn = apply({
      settings: settingsWith({ defaultTuiAgent: 'codex' }),
      mutation: { kind: 'set-enabled', agent: 'codex', enabled: false }
    })
    expect(builtIn.ok).toBe(true)
    if (!builtIn.ok) {
      return
    }
    expect(builtIn.patch.defaultTuiAgent).toBeNull()

    // Auto remains Auto and simply skips the disabled base.
    const auto = apply({
      settings: settingsWith({ defaultTuiAgent: 'auto' }),
      mutation: { kind: 'set-enabled', agent: 'codex', enabled: false }
    })
    expect(auto.ok).toBe(true)
    if (!auto.ok) {
      return
    }
    expect('defaultTuiAgent' in auto.patch).toBe(false)
  })

  it('rejects unknown identities', () => {
    const result = apply({
      mutation: { kind: 'set-enabled', agent: customId('codex', UUID_B), enabled: false }
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_agent_field' })
  })
})

describe('set-default', () => {
  it('accepts auto, blank, and enabled live identities; the public type cannot carry null', () => {
    const live = liveAgent()
    for (const target of ['auto', 'blank', 'codex', live.id] as const) {
      const result = apply({
        settings: settingsWith({ customTuiAgents: [live] }),
        mutation: { kind: 'set-default', agent: target }
      })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        continue
      }
      expect(result.patch.defaultTuiAgent).toBe(target)
    }
  })

  it('rejects disabled, tombstoned, unknown, and repair-required identities', () => {
    const live = liveAgent()
    const broken = {
      ...liveAgent({ id: customId('claude', UUID_B), baseAgent: 'claude' }),
      label: ''
    }
    const settings = settingsWith({
      customTuiAgents: [live, broken],
      disabledTuiAgents: [live.id],
      deletedCustomTuiAgents: []
    })
    for (const target of [live.id, broken.id, customId('gemini', UUID_B), 'gemini'] as const) {
      const useSettings =
        target === 'gemini' ? settingsWith({ disabledTuiAgents: ['gemini'] }) : settings
      const result = apply({
        settings: useSettings,
        mutation: { kind: 'set-default', agent: target }
      })
      expect(result.ok).toBe(false)
    }
  })
})

describe('update-built-in', () => {
  it('writes the three override slots and clears empty ones', () => {
    const result = apply({
      settings: settingsWith({
        agentCmdOverrides: { codex: '/old' },
        agentDefaultArgs: { codex: '--old' },
        agentDefaultEnv: { codex: { OLD: '1' } }
      }),
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: '/new/codex', args: '', env: { NEW: '2' } }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.patch.agentCmdOverrides).toEqual({ codex: '/new/codex' })
    expect(result.patch.agentDefaultArgs).toEqual({})
    expect(result.patch.agentDefaultEnv).toEqual({ codex: { NEW: '2' } })
  })

  it('rejects control characters and prototype keys while keeping multi-token compatibility', () => {
    const multiToken = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: '/opt/wrap codex --flag', args: '', env: {} }
      }
    })
    expect(multiToken.ok).toBe(true)

    const controlChar = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: 'a\nb', args: '', env: {} }
      }
    })
    expect(controlChar).toMatchObject({ ok: false, reason: 'control_char' })

    const protoKey = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: {
          commandOverride: null,
          args: '',
          env: JSON.parse('{"__proto__": "x"}') as Record<string, string>
        }
      }
    })
    expect(protoKey).toMatchObject({ ok: false, reason: 'prototype_key' })
  })

  it('rejects reserved ORCA_* env names and case collisions like the custom path', () => {
    const reserved = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: null, args: '', env: { ORCA_PANE_KEY: 'spoof' } }
      }
    })
    expect(reserved).toMatchObject({ ok: false, reason: 'reserved_name' })

    const collision = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: null, args: '', env: { Path: 'a', PATH: 'b' } }
      }
    })
    expect(collision).toMatchObject({ ok: false, reason: 'case_collision' })
  })
})

describe('update-custom tombstone prune (L1-#8)', () => {
  it('persists the prune in the same write when an update takes a freed tombstone label', () => {
    const live = liveAgent({ label: 'Old Name' })
    const freed: DeletedCustomTuiAgent = {
      id: customId('codex', UUID_B),
      baseAgent: 'codex',
      label: 'Freed Label',
      deletedAt: 1
    }
    const result = apply({
      settings: settingsWith({ customTuiAgents: [live], deletedCustomTuiAgents: [freed] }),
      countTombstoneReferences: () => 0,
      mutation: {
        kind: 'update-custom',
        id: live.id,
        changes: { label: 'Freed Label', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    // The label check passed against the pruned view, so the prune must land in
    // the same patch or the freed label would coexist with its tombstone.
    expect(result.patch.deletedCustomTuiAgents).toEqual([])
    expect(result.prunedTombstoneIds).toEqual([freed.id])
  })

  it('retains referenced tombstones and still rejects their labels', () => {
    const live = liveAgent({ label: 'Old Name' })
    const kept: DeletedCustomTuiAgent = {
      id: customId('codex', UUID_B),
      baseAgent: 'codex',
      label: 'Kept Label',
      deletedAt: 1
    }
    const result = apply({
      settings: settingsWith({ customTuiAgents: [live], deletedCustomTuiAgents: [kept] }),
      countTombstoneReferences: () => 1,
      mutation: {
        kind: 'update-custom',
        id: live.id,
        changes: { label: 'Kept Label', commandOverride: null, args: '', env: {}, syncEnv: false }
      }
    })
    expect(result).toMatchObject({ ok: false, code: 'duplicate_agent_label' })
  })
})

describe('update-built-in malformed payloads (L1-#6)', () => {
  it('returns a typed error for null changes instead of throwing', () => {
    const result = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: null as unknown as { commandOverride: null; args: string; env: {} }
      }
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_agent_field', reason: 'bounds' })
  })

  it('returns a typed error when args is missing or not a string instead of throwing', () => {
    const missingArgs = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: null, env: {} } as unknown as {
          commandOverride: null
          args: string
          env: {}
        }
      }
    })
    expect(missingArgs).toMatchObject({
      ok: false,
      code: 'invalid_agent_field',
      field: 'args',
      reason: 'bounds'
    })

    const numberArgs = apply({
      mutation: {
        kind: 'update-built-in',
        agent: 'codex',
        changes: { commandOverride: null, args: 42, env: {} } as unknown as {
          commandOverride: null
          args: string
          env: {}
        }
      }
    })
    expect(numberArgs).toMatchObject({ ok: false, field: 'args', reason: 'bounds' })
  })

  it('returns a typed error for a non-string commandOverride instead of throwing on trim', () => {
    for (const override of [42, { path: '/x' }]) {
      const result = apply({
        mutation: {
          kind: 'update-built-in',
          agent: 'codex',
          changes: { commandOverride: override, args: '', env: {} } as unknown as {
            commandOverride: null
            args: string
            env: {}
          }
        }
      })
      expect(result).toMatchObject({
        ok: false,
        code: 'invalid_agent_field',
        field: 'commandOverride',
        reason: 'bounds'
      })
    }
  })
})
