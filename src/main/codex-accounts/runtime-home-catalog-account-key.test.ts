// A new Codex chat's picker reads the catalog under the account key the record-less resolver
// answers; the chat it launches saves under the key launch preparation pins. Both run for real
// here, wired as the runtime service wires them, so a drift between the two fails this test.

import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexHomePath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

// Hook install and session bridges are launch chores outside the key; keep them off disk.
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: async () => ({ state: 'installed' }) }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: async () => {} }))
vi.mock('../codex/codex-session-bridge', () => ({
  startSystemCodexSessionBridgeInBackground: async () => {}
}))
vi.mock('../codex/codex-account-session-bridge', () => ({
  startCodexAccountSessionBridgeInBackground: async () => {}
}))

/** The production wiring: the host's one runtime home service behind both resolvers. */
async function wireCodexAccountKey(settings: ReturnType<typeof createSettings>) {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { mainProcessState } = await import('../startup/main-process-state')
  const { codexStructuredLaunchHomeResolvers } = await import('../startup/codex-launch-preparation')
  const { structuredAgentRuntimeRegistration } =
    await import('../runtime/structured-agent-runtime-registrations')
  const { agentModelCatalogFingerprint } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-fingerprint')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the settings read/update surface the service uses.
  const runtimeHome = new CodexRuntimeHomeService(createStore(settings) as never)
  mainProcessState.codexRuntimeHome = runtimeHome
  const codex = structuredAgentRuntimeRegistration('codex')!
  const services = {
    getClaudeConfigDirectory: () => null,
    // The resolvers main-process-runtime-service hands the runtime.
    prepareCodexLaunchHome: codexStructuredLaunchHomeResolvers.prepareCodexStructuredLaunch,
    readCodexLaunchHome: codexStructuredLaunchHomeResolvers.resolveCodexStructuredLaunchHome,
    workspaceTrustSettings: () => settings
  }
  const resolve = (purpose: 'launch' | 'read') =>
    codex.resolveAccountHome(
      { launchEnv: {}, location: null, purpose, workspacePath: null },
      services
    )
  const key = (accountHome: AgentSessionAccountHome) =>
    agentModelCatalogFingerprint({ agent: 'codex', accountHome, wslDistro: null })
  return { resolve, key, release: () => (mainProcessState.codexRuntimeHome = null) }
}

describe('Codex catalog account key: picker read vs launch', () => {
  let release: (() => void) | null = null

  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    release?.()
    release = null
    teardownRuntimeHomeTest()
  })

  async function expectOneKey(settings: ReturnType<typeof createSettings>, expectedPath: string) {
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const before = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    // Launch preparation syncs homes; the next picker read must still land on the same key.
    const after = await wired.resolve('read')

    expect(launched).toMatchObject({ variable: 'CODEX_HOME', path: expectedPath })
    expect(wired.key(before)).toBe(wired.key(launched))
    expect(wired.key(after)).toBe(wired.key(launched))
  }

  it('system account on the real ~/.codex', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: true }), getSystemCodexHomePath())
  })

  it("system account on Orca's shared runtime home", async () => {
    await expectOneKey(createSettings({ realHomeRoutable: false }), getRuntimeCodexHomePath())
  })

  it('a managed account in its own home', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    await expectOneKey(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      }),
      managedHomePath
    )
  })
})
