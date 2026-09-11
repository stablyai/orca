import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { supportsStructuredAgentSessions } from './rpc/methods/structured-agent-session-policy'
import { SettingsUpdate } from '../../shared/rpc-contract/client-settings-params'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { GlobalSettings } from '../../shared/global-settings-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function createHeadlessHost(structuredNativeChatEnabled: boolean): OrcaRuntimeService {
  let settings: Partial<GlobalSettings> = {
    workspaceDir: '/tmp/orca-remote-admission-update',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    compactWorktreeCards: false,
    experimentalStructuredNativeChat: structuredNativeChatEnabled
  }
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    }
  }
  return new OrcaRuntimeService(store as never)
}

/** Goes through the real RPC decoder, which is strict: an unmodelled key is rejected outright. */
async function applyPairedSettingsUpdate(
  runtime: OrcaRuntimeService,
  payload: Record<string, unknown>
): Promise<void> {
  await runtime.updateClientSettings(SettingsUpdate.parse(payload))
}

function admitsCapableRemoteCaller(runtime: OrcaRuntimeService): boolean {
  return supportsStructuredAgentSessions({
    runtime,
    clientKind: 'runtime',
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  })
}

describe('structured-chat admission over the paired settings update', () => {
  it('lets a paired client flip a headless host from refusing to admitting', async () => {
    const runtime = createHeadlessHost(false)
    expect(admitsCapableRemoteCaller(runtime)).toBe(false)

    await applyPairedSettingsUpdate(runtime, { experimentalStructuredNativeChat: true })

    expect(admitsCapableRemoteCaller(runtime)).toBe(true)
  })

  it('publishes the flipped admission on the next status read', async () => {
    const runtime = createHeadlessHost(false)
    expect(runtime.getStatus().structuredSessionAdmission).toEqual({ enabled: false })

    await applyPairedSettingsUpdate(runtime, { experimentalStructuredNativeChat: true })

    expect(runtime.getStatus().structuredSessionAdmission).toEqual({ enabled: true })
  })

  it('turns admission back off when the client sends false', async () => {
    const runtime = createHeadlessHost(true)

    await applyPairedSettingsUpdate(runtime, { experimentalStructuredNativeChat: false })

    expect(admitsCapableRemoteCaller(runtime)).toBe(false)
    expect(runtime.getStatus().structuredSessionAdmission).toEqual({ enabled: false })
  })

  it('leaves the setting untouched when an update omits the key', async () => {
    const runtime = createHeadlessHost(true)

    await applyPairedSettingsUpdate(runtime, { compactWorktreeCards: true })

    expect(runtime.getClientSettings().experimentalStructuredNativeChat).toBe(true)
    expect(runtime.getClientSettings().compactWorktreeCards).toBe(true)
  })
})
