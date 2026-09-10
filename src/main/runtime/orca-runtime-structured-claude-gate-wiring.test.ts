import { describe, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => ({ deps: null as Record<string, unknown> | null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: Record<string, unknown>) => {
    installed.deps = deps
  })
}))

import { OrcaRuntimeService } from './orca-runtime'
import {
  readClaudeManagedAccountGateSettings,
  type ClaudeManagedAccountGateSettings
} from '../native-chat/claude-structured-managed-account-support'

const SETTINGS = {
  claudeManagedAccounts: [],
  activeClaudeManagedAccountId: null,
  agentDefaultEnv: {},
  agentDefaultArgs: {}
} as unknown as ClaudeManagedAccountGateSettings

function gateSettingsGetter(): (() => ClaudeManagedAccountGateSettings) | undefined {
  const deps: Record<string, unknown> = installed.deps ?? {}
  const get = deps['getClaudeManagedAccountGateSettings']
  return typeof get === 'function' ? (get as () => ClaudeManagedAccountGateSettings) : undefined
}

/** The runtime class this wiring lives on does not typecheck its own `this` calls, so a broken or
 *  missing gate hookup compiles clean. Pin it behaviourally instead. */
describe('structured Claude managed-account gate wiring', () => {
  it('hands the host a gate reader that resolves the live settings', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService({ getSettings: () => SETTINGS } as never)

    await runtime.ensureStructuredAgentSessionHost()

    const get = gateSettingsGetter()
    expect(typeof get).toBe('function')
    expect(get?.()).toBe(SETTINGS)
  })

  /** The installer composes this getter with the fail-closed reader, which is the shape the
   *  resolver consumes; pin that composition end to end. */
  it('composes into a null answer instead of throwing when settings cannot be read', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    const get = gateSettingsGetter()
    expect(typeof get).toBe('function')
    expect(() => get?.()).toThrow()
    expect(readClaudeManagedAccountGateSettings(get!)).toBeNull()
  })
})
