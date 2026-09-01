// U6: the runtime backing for the automation resolve-only agent-launch gate.
// classifyAgentLaunchForAutomation resolves the agent WITHOUT spawning and maps a
// known launch failure to a PLAIN structured failure; the service stamps the
// persisted wrapper at its single persist point (ledger #12). A resolvable agent
// returns null so dispatch proceeds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { CustomTuiAgentId, Repo } from '../../shared/types'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { OrcaRuntimeService } from './orca-runtime'

const testState = { dir: '' }

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

async function createStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

const REPO: Repo = {
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
}
const CUSTOM_AGENT_ID: CustomTuiAgentId = 'custom-agent:claude:01234567-89ab-4cde-8f01-23456789abcd'

describe('OrcaRuntimeService.classifyAgentLaunchForAutomation (U6)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-classify-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('returns a plain structured failure for a disabled base agent (no wrapper mint)', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    store.updateSettings({ disabledTuiAgents: ['claude'] })
    const runtime = new OrcaRuntimeService(store)

    const failure = runtime.classifyAgentLaunchForAutomation('claude', REPO, 'run-1', '/repo')

    expect(failure).not.toBeNull()
    expect(failure?.code).toBe('base_agent_disabled')
    // Plain failure only — the persisted wrapper fields are the service's to mint.
    expect(failure).not.toHaveProperty('failureId')
    expect(failure).not.toHaveProperty('version')
    expect(failure).not.toHaveProperty('intent')
    expect(failure).not.toHaveProperty('occurredAt')
  })

  it('returns null for a resolvable (enabled) agent so dispatch proceeds', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    const runtime = new OrcaRuntimeService(store)

    expect(runtime.classifyAgentLaunchForAutomation('claude', REPO, 'run-1', '/repo')).toBeNull()
  })

  it('classifies custom agents with automation repo and worktree variables', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    store.updateSettings({
      customTuiAgents: [
        {
          id: CUSTOM_AGENT_ID,
          baseAgent: 'claude',
          label: 'Context Agent',
          args: '--repo {repoPath} --worktree {worktreePath}',
          env: { AUTOMATION_ROOT: '{worktreePath}' },
          syncEnv: false
        }
      ]
    })
    const runtime = new OrcaRuntimeService(store)

    expect(
      runtime.classifyAgentLaunchForAutomation(
        CUSTOM_AGENT_ID,
        REPO,
        'run-context',
        '/repo/worktrees/context'
      )
    ).toBeNull()
  })

  it('classifies local custom command overrides against the target home', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    store.updateSettings({
      customTuiAgents: [
        {
          id: CUSTOM_AGENT_ID,
          baseAgent: 'claude',
          label: 'Home Agent',
          commandOverride: '~/my agent/bin/claude',
          args: '',
          env: {},
          syncEnv: false
        }
      ]
    })
    const runtime = new OrcaRuntimeService(store)

    expect(
      runtime.classifyAgentLaunchForAutomation(CUSTOM_AGENT_ID, REPO, 'run-home', '/repo')
    ).toBeNull()
  })

  it('builds a base-harness startup for a custom agent (headless dispatch path)', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    store.updateSettings({
      customTuiAgents: [
        {
          id: CUSTOM_AGENT_ID,
          baseAgent: 'claude',
          label: 'Context Agent',
          args: '--add-dir {worktreePath}',
          env: { AUTOMATION_ROOT: '{worktreePath}' },
          syncEnv: false
        }
      ]
    })
    const runtime = new OrcaRuntimeService(store)
    const internals = runtime as unknown as {
      buildStartupForAgent: (
        repo: Repo,
        agent: string,
        prompt: string | undefined,
        launchPreferences?: undefined,
        worktreePath?: string
      ) => {
        agent: string
        launchAgent?: string
        startup: { command: string; env?: Record<string, string> }
      }
    }

    const startup = internals.buildStartupForAgent(
      REPO,
      CUSTOM_AGENT_ID,
      'Review changes',
      undefined,
      '/repo/worktrees/context'
    )

    expect(startup.agent).toBe(CUSTOM_AGENT_ID)
    // Terminal surfacing uses the resolved base harness, mirroring the
    // host-atomic paths' receipt.baseAgent.
    expect(startup.launchAgent).toBe('claude')
    expect(startup.startup.command).toContain('claude')
    expect(startup.startup.command).toContain('/repo/worktrees/context')
    expect(startup.startup.env).toMatchObject({ AUTOMATION_ROOT: '/repo/worktrees/context' })
  })

  it('throws a coded error for an unresolvable custom agent instead of spawning', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    const runtime = new OrcaRuntimeService(store)
    const internals = runtime as unknown as {
      buildStartupForAgent: (repo: Repo, agent: string, prompt: string | undefined) => unknown
    }

    expect(() => internals.buildStartupForAgent(REPO, CUSTOM_AGENT_ID, 'Review changes')).toThrow(
      /Could not build launch command/
    )
  })

  it('threads the catalog into the draft-ready budget so a custom id inherits its base harness', async () => {
    const codexCustomId = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'
    const store = await createStore()
    store.addRepo(REPO)
    store.updateSettings({
      customTuiAgents: [
        {
          id: codexCustomId,
          baseAgent: 'codex',
          label: 'Codex Prod',
          args: '',
          env: {},
          syncEnv: false
        }
      ]
    })
    const runtime = new OrcaRuntimeService(store)
    const internals = runtime as unknown as {
      getLivePtyForHandle: (handle: string) => unknown
      subscribeToTerminalData: (ptyId: string, listener: (data: string) => void) => () => void
      waitForStartupDraftReady: (handle: string, agent: string) => Promise<string | null>
    }
    internals.getLivePtyForHandle = () => ({ pty: { ptyId: 'pty-1' } })
    internals.subscribeToTerminalData = () => () => {}

    vi.useFakeTimers()
    try {
      let settled = false
      const wait = internals.waitForStartupDraftReady('h1', codexCustomId).then((value) => {
        settled = true
        return value
      })
      // Without the catalog the default 8s budget would have fired here.
      await vi.advanceTimersByTimeAsync(8_100)
      expect(settled).toBe(false)
      // Codex's 20s base budget applies to the custom id.
      await vi.advanceTimersByTimeAsync(12_000)
      expect(await wait).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the legacy resolve-only target home unknown', async () => {
    const store = await createStore()
    store.addRepo(REPO)
    const runtime = new OrcaRuntimeService(store)
    const internals = runtime as unknown as {
      buildResolveOnlySpawnTarget: (
        repo: Repo,
        includeLocalTargetHome?: boolean
      ) => { targetHomePath: string | null }
    }

    expect(internals.buildResolveOnlySpawnTarget(REPO).targetHomePath).toBeNull()
    expect(internals.buildResolveOnlySpawnTarget(REPO, true).targetHomePath).toBe(homedir())
  })
})
