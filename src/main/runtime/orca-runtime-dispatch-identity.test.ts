// W-T1 (§U9, ledger #9): the orchestration coordinator resolves a dispatch's
// agent identity from the terminal that ACTUALLY receives the work (Option B,
// target-terminal attribution). These are the activation tests: a real launch
// attribution resolves to the requested (possibly custom) identity, a hook-only
// terminal is its own requested agent, and an unattributed target returns null
// so the coordinator skips validation instead of guessing.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const CUSTOM_CODEX_ID = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd'
const SETTINGS = {
  customTuiAgents: [{ id: CUSTOM_CODEX_ID, baseAgent: 'codex' }],
  deletedCustomTuiAgents: []
}

type DispatchIdentityInternals = {
  store: { getSettings: () => unknown }
  handles: Map<string, { ptyId: string | null }>
  ptysById: Map<string, { launchAgent?: string; foregroundAgent?: string }>
  resolveDispatchAgentIdentityForHandle: (
    handle: string
  ) => { requestedAgent: string; baseAgent: string | null } | null
}

function makeRuntime(
  ptys: Record<string, { launchAgent?: string; foregroundAgent?: string }>
): DispatchIdentityInternals {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as DispatchIdentityInternals
  internals.store = { getSettings: () => SETTINGS }
  internals.handles = new Map(
    Object.keys(ptys).map((ptyId) => [`term_${ptyId}`, { ptyId }])
  )
  internals.ptysById = new Map(Object.entries(ptys))
  return internals
}

describe('resolveDispatchAgentIdentityForHandle (W-T1 Option B)', () => {
  it('returns the true requested custom identity + base for a launch-attributed target', () => {
    const internals = makeRuntime({ p1: { launchAgent: CUSTOM_CODEX_ID } })
    expect(internals.resolveDispatchAgentIdentityForHandle('term_p1')).toEqual({
      requestedAgent: CUSTOM_CODEX_ID,
      baseAgent: 'codex'
    })
  })

  it('treats a hook-only base attribution as its own requested agent', () => {
    // No launchAgent: the terminal is attributed to a built-in base via hook
    // metadata alone. A built-in id is its own requested agent (ledger #9).
    const internals = makeRuntime({ p2: { foregroundAgent: 'claude' } })
    expect(internals.resolveDispatchAgentIdentityForHandle('term_p2')).toEqual({
      requestedAgent: 'claude',
      baseAgent: 'claude'
    })
  })

  it('returns null for an unattributed target so validation is skipped, never guessed', () => {
    const internals = makeRuntime({ p3: {} })
    expect(internals.resolveDispatchAgentIdentityForHandle('term_p3')).toBeNull()
  })

  it('returns null for an unknown handle', () => {
    const internals = makeRuntime({ p1: { launchAgent: CUSTOM_CODEX_ID } })
    expect(internals.resolveDispatchAgentIdentityForHandle('term_missing')).toBeNull()
  })
})
