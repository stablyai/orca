import { describe, expect, it } from 'vitest'

import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../../src/shared/types'
import {
  buildMobileAgentPickerRows,
  isHostAgentCatalogMigrationBlocked
} from './mobile-agent-catalog-projection'
import { MOBILE_AGENT_CATALOG } from './mobile-agent-catalog'
import { MOBILE_TUI_AGENT_AUTO_PICK_ORDER } from './mobile-tui-agents'

function readyCustom(
  id: CustomTuiAgentId,
  baseAgent: BuiltInTuiAgent,
  label: string
): AgentCatalogSnapshot['customAgents'][number] {
  return {
    id,
    baseAgent,
    label,
    args: '',
    syncEnv: false,
    status: 'ready',
    envState: 'none',
    availabilityCheck: 'baseline-detection'
  }
}

function snapshot(overrides: Partial<AgentCatalogSnapshot> = {}): AgentCatalogSnapshot {
  return {
    version: 1,
    revision: 3,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: [],
    ...overrides
  }
}

const projectionError = {
  version: 1,
  revision: 2,
  code: 'agent_catalog_payload_too_large'
} as unknown as AgentCatalogValue

describe('mobile agent catalog projection', () => {
  it('returns exactly the static built-in rows with no snapshot', () => {
    const rows = buildMobileAgentPickerRows(null)
    expect(rows.map((row) => row.id)).toEqual([...MOBILE_TUI_AGENT_AUTO_PICK_ORDER])
    expect(rows.every((row) => row.isCustom === false)).toBe(true)
  })

  it('preserves the static favicon domains on built-in rows', () => {
    const rows = buildMobileAgentPickerRows(null)
    for (const entry of MOBILE_AGENT_CATALOG) {
      const row = rows.find((candidate) => candidate.id === entry.id)
      expect(row?.faviconDomain).toBe(entry.faviconDomain)
    }
  })

  it('keeps customs out until the identity-launch flip gates them on', () => {
    const withCustom = snapshot({
      customAgents: [readyCustom('custom-agent:claude:one', 'claude', 'My Claude')]
    })
    // Default (gate off) hides customs even with a full snapshot.
    expect(buildMobileAgentPickerRows(withCustom)).toEqual(buildMobileAgentPickerRows(null))
  })

  it('inserts an enabled ready custom directly below its base harness', () => {
    const rows = buildMobileAgentPickerRows(
      snapshot({
        customAgents: [readyCustom('custom-agent:claude:one', 'claude', 'My Claude')]
      }),
      { includeCustomAgents: true }
    )
    const claudeIndex = rows.findIndex((row) => row.id === 'claude')
    expect(rows[claudeIndex + 1]).toEqual({
      id: 'custom-agent:claude:one',
      label: 'My Claude',
      isCustom: true,
      baseAgent: 'claude'
    })
  })

  it('groups multiple customs under the same base in snapshot order', () => {
    const rows = buildMobileAgentPickerRows(
      snapshot({
        customAgents: [
          readyCustom('custom-agent:codex:a', 'codex', 'Codex A'),
          readyCustom('custom-agent:codex:b', 'codex', 'Codex B')
        ]
      }),
      { includeCustomAgents: true }
    )
    const codexIndex = rows.findIndex((row) => row.id === 'codex')
    expect(rows[codexIndex + 1]?.id).toBe('custom-agent:codex:a')
    expect(rows[codexIndex + 2]?.id).toBe('custom-agent:codex:b')
    // The next base row still follows the custom group, not before it.
    expect(rows[codexIndex + 3]?.isCustom).toBe(false)
  })

  it('hides repair-required customs from the picker', () => {
    const rows = buildMobileAgentPickerRows(
      snapshot({
        customAgents: [
          {
            id: 'custom-agent:codex:broken',
            baseAgent: 'codex',
            label: 'Broken',
            status: 'repair-required',
            envState: 'none'
          }
        ]
      }),
      { includeCustomAgents: true }
    )
    expect(rows.some((row) => row.isCustom)).toBe(false)
  })

  it('hides customs listed in disabledAgents', () => {
    const rows = buildMobileAgentPickerRows(
      snapshot({
        customAgents: [readyCustom('custom-agent:claude:one', 'claude', 'My Claude')],
        disabledAgents: ['custom-agent:claude:one']
      }),
      { includeCustomAgents: true }
    )
    expect(rows.some((row) => row.isCustom)).toBe(false)
  })

  it('hides built-in harnesses listed in disabledAgents', () => {
    const rows = buildMobileAgentPickerRows(snapshot({ disabledAgents: ['codex'] }), {
      includeCustomAgents: true
    })
    expect(rows.some((row) => row.id === 'codex')).toBe(false)
    expect(rows.some((row) => row.id === 'claude')).toBe(true)
  })

  it('hides disabled built-ins even with customs gated off', () => {
    const rows = buildMobileAgentPickerRows(snapshot({ disabledAgents: ['codex'] }))
    expect(rows.some((row) => row.id === 'codex')).toBe(false)
  })

  it('hides customs whose base harness is disabled', () => {
    const rows = buildMobileAgentPickerRows(
      snapshot({
        customAgents: [readyCustom('custom-agent:codex:a', 'codex', 'Codex A')],
        disabledAgents: ['codex']
      }),
      { includeCustomAgents: true }
    )
    expect(rows.some((row) => row.isCustom)).toBe(false)
  })

  it('falls back to built-in rows when the projection is oversize', () => {
    const rows = buildMobileAgentPickerRows(projectionError, { includeCustomAgents: true })
    expect(rows).toEqual(buildMobileAgentPickerRows(null))
  })

  it('never emits a custom row carrying an env key or value', () => {
    const rows = buildMobileAgentPickerRows(
      snapshot({
        customAgents: [readyCustom('custom-agent:claude:one', 'claude', 'My Claude')]
      }),
      { includeCustomAgents: true }
    )
    const allowedKeys = new Set(['id', 'label', 'faviconDomain', 'isCustom', 'baseAgent'])
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(allowedKeys.has(key)).toBe(true)
      }
      expect('env' in row).toBe(false)
    }
    const custom = rows.find((row) => row.isCustom)
    expect(Object.keys(custom ?? {}).sort()).toEqual(['baseAgent', 'id', 'isCustom', 'label'])
  })

  it('reads the host migration-blocked flag as a boolean-only projection', () => {
    expect(isHostAgentCatalogMigrationBlocked(null)).toBe(false)
    expect(isHostAgentCatalogMigrationBlocked(snapshot())).toBe(false)
    expect(isHostAgentCatalogMigrationBlocked(projectionError)).toBe(false)
    const blocked = snapshot({ migrationBlocked: true })
    expect(isHostAgentCatalogMigrationBlocked(blocked)).toBe(true)
    // The wire value carries no error text or path — boolean only.
    expect(JSON.stringify(blocked)).not.toMatch(/error|\/Users\//i)
  })
})
