import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearProviderPtyState } from './provider/state-cleanup'
import {
  hasClaudeCredentialOwners,
  hasLiveLegacyClaudePtys,
  hasLiveClaudePtys,
  markClaudePtyExited,
  attachClaudeLivePtyPersistence,
  seedLiveClaudePtysFromPersistence,
  confirmSeededClaudeLivePtys
} from '../../claude-accounts/live-pty-gate'
import { localProvider, setLocalPtyProvider } from './provider/registry'
import { runPtyIpcSpawn } from './ipc/spawn-run'
import { spawnPtyFromRuntimeController } from './runtime/spawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { getDefaultSettings } from '../../../shared/constants'
import type { AgentProfileSnapshot } from '../../../shared/agent-launch-profile'
import { finishPtyShutdown } from './provider/liveness'
import { prepareRuntimePtySpawn } from './runtime/spawn-preflight'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import { createPtyIpcSpawnState } from './ipc/spawn-state'
import { preparePtyIpcSpawnPreflight } from './ipc/spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './ipc/spawn-env'
import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import type { PtySpawnIpcDeps, PtySpawnIpcArgs } from './ipc/spawn-types'
import { noCodexResumeLaunch } from './host-env/codex-resume'
import type { PreparedAgentProfile } from '../../agent-profiles/connection-service'
vi.mock('../../pty/codex-no-daemon-launch-command', () => ({ planCodexNoDaemonLaunch: () => null }))
const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
  markClaudePtyExited('profile-committed')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
function fixture(agent: 'claude' | 'codex', external = false) {
  const snapshot: AgentProfileSnapshot = {
    id: 'a',
    name: 'A',
    agent,
    hostId: 'local',
    executable: '/tools/provider',
    binding: external
      ? { kind: 'external', home: '/external' }
      : { kind: 'managed', accountId: 'a' },
    resolvedHome: external ? '/external' : '/accounts/a',
    identity: { kind: 'verified', subject: 'a', displayName: 'A' }
  }
  const prepared: PreparedAgentProfile = {
    snapshot,
    envPatch: { [agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: snapshot.resolvedHome },
    envToDelete: external ? [] : ['OPENAI_API_KEY'],
    release: vi.fn()
  }
  const service = {
    prepare: vi.fn(async () => prepared),
    prepareById: vi.fn(async () => prepared),
    validateLaunch: vi.fn(async () => {})
  }
  const homeSpawned = vi.fn()
  const selected = vi.fn(async () => '/selected/b')
  const legacy = vi.fn()
  const resume = vi.fn(() => null)
  const deps: PtyRuntimeControllerDeps & PtySpawnIpcDeps = {
    options: { onCodexHomePtySpawned: homeSpawned },
    agentProfiles: service,
    getSelectedCodexHomePath: selected,
    prepareClaudeAuth: legacy,
    getSettings: () => ({ ...getDefaultSettings('/tmp'), agentWorkspaceTrustEnabled: false }),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: resume,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    reconcileSharedRuntimeResumeHome: async (home) => home.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertFolderWorkspacePtyPathUsable: () => {},
    resolvePtySpawnStartupCwd: (_id, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    localStartupCwdDirectoryExists: () => true,
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    syncPtyBackgroundedDelivery: () => {},
    stopReplacedPty: async () => {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn preparation never reads the renderer window.
    mainWindow: {} as BrowserWindow
  }
  return { deps, prepared, service, selected, legacy, resume, homeSpawned }
}
async function launch(
  surface: 'desktop' | 'runtime',
  deps: PtyRuntimeControllerDeps & PtySpawnIpcDeps,
  args: Omit<PtySpawnIpcArgs, 'terminalColorQueryReplies'>
) {
  if (surface === 'desktop') {
    const ctx = createPtyIpcSpawnState(deps, args)
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    await buildPtyIpcSpawnOptions(ctx)
    releases.push(ctx.finishTerminalInstall)
    return { options: ctx.spawnOptions, config: ctx.effectiveLaunchConfig }
  }
  const ctx = createRuntimePtySpawnState(deps, args)
  await prepareRuntimePtySpawn(ctx)
  await buildRuntimePtySpawnOptions(ctx)
  releases.push(ctx.finishTerminalInstall)
  return { options: ctx.spawnOptions, config: ctx.args.launchConfig }
}
describe.each(['desktop', 'runtime'] as const)('%s profile orchestration', (surface) => {
  it.each(['claude', 'codex'] as const)(
    'prepares requested %s profile independently of selection',
    async (agent) => {
      const f = fixture(agent)
      const result = await launch(surface, f.deps, {
        cols: 80,
        rows: 24,
        command: `${agent} --model test`,
        launchAgent: agent,
        agentProfileId: 'a',
        commandDelivery: 'renderer'
      })
      expect(f.service.prepareById).toHaveBeenCalledWith(
        'a',
        expect.objectContaining({ mode: 'terminal', resume: false })
      )
      expect(f.selected).not.toHaveBeenCalled()
      expect(f.legacy).not.toHaveBeenCalled()
      expect(f.resume).not.toHaveBeenCalled()
      expect(result.options).toMatchObject({
        launchAgent: agent,
        commandDelivery: 'provider',
        env: f.prepared.envPatch
      })
      expect(result.options.command).toContain('/usr/bin/env')
      expect(result.options.command).toContain('/tools/provider')
      expect(result.options.command).toContain('--model')
      expect(result.config?.agentProfile).toEqual(f.prepared.snapshot)
      expect(result.config?.agentProfile?.binding).not.toBe(f.prepared.snapshot.binding)
    }
  )
  it.each(['claude', 'codex'] as const)(
    'keeps external %s away from all managed preparation',
    async (agent) => {
      const f = fixture(agent, true)
      await launch(surface, f.deps, { cols: 80, rows: 24, command: agent, agentProfileId: 'a' })
      expect(f.selected).not.toHaveBeenCalled()
      expect(f.legacy).not.toHaveBeenCalled()
      expect(f.resume).not.toHaveBeenCalled()
    }
  )
  it('resumes the snapshot without resolving a profile ID', async () => {
    const f = fixture('codex')
    const captured = { ...f.prepared.snapshot, name: 'Before edit' }
    await launch(surface, f.deps, {
      cols: 80,
      rows: 24,
      command: 'codex resume session',
      ...(surface === 'desktop' ? { replacesPtyId: 'old-codex' } : {}),
      launchAgent: 'codex',
      launchConfig: { agentArgs: '', agentEnv: {}, agentProfile: captured }
    })
    expect(f.service.prepareById).not.toHaveBeenCalled()
    expect(f.service.prepare).toHaveBeenCalledWith(
      captured,
      expect.objectContaining({ resume: true })
    )
    expect(f.resume).not.toHaveBeenCalled()
  })
  it('reattaches a named process without touching its account', async () => {
    const f = fixture('codex')
    const result = await launch(surface, f.deps, {
      cols: 80,
      rows: 24,
      sessionId: 'live',
      agentProfileId: 'deleted'
    })
    expect(result.options.attachOnly).toBe(true)
    expect(result.options.command).toBeUndefined()
    expect(f.service.prepareById).not.toHaveBeenCalled()
    expect(f.selected).not.toHaveBeenCalled()
    expect(f.legacy).not.toHaveBeenCalled()
  })
  it('keeps ordinary selected-home preparation', async () => {
    const f = fixture('codex')
    await launch(surface, f.deps, {
      cols: 80,
      rows: 24,
      ...(surface === 'desktop' ? { replacesPtyId: 'old-codex' } : {})
    })
    expect(f.selected).toHaveBeenCalled()
    expect(f.resume).toHaveBeenCalledWith(
      expect.objectContaining(surface === 'desktop' ? { useSelectedAccount: true } : {})
    )
    expect(f.service.prepareById).not.toHaveBeenCalled()
  })
  it('refuses contradictory snapshot/ID and provider before managed work', async () => {
    const f = fixture('codex')
    await expect(
      launch(surface, f.deps, {
        cols: 80,
        rows: 24,
        command: 'claude',
        launchAgent: 'claude',
        agentProfileId: 'a',
        launchConfig: { agentArgs: '', agentEnv: {}, agentProfile: f.prepared.snapshot }
      })
    ).rejects.toThrow(/binding/)
    expect(f.selected).not.toHaveBeenCalled()
    expect(f.service.prepare).not.toHaveBeenCalled()
  })
})

describe.each(['desktop', 'runtime'] as const)('%s full profile spawn lifecycle', (surface) => {
  const run = surface === 'desktop' ? runPtyIpcSpawn : spawnPtyFromRuntimeController
  it('releases the profile once after a successful provider commit', async () => {
    const f = fixture('claude')
    const spawn = vi
      .spyOn(localProvider, 'spawn')
      .mockResolvedValue({ id: 'profile-committed', pid: 123 })
    await run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
    expect(f.homeSpawned).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    expect(f.prepared.release).toHaveBeenCalledOnce()
    expect(hasLiveClaudePtys()).toBe(true)
    expect(hasLiveLegacyClaudePtys()).toBe(false)
  })
  it('releases the profile once when the provider cannot spawn', async () => {
    const f = fixture('claude')
    vi.spyOn(localProvider, 'spawn').mockRejectedValue(new Error('synthetic spawn failed'))
    await expect(
      run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
    ).rejects.toThrow('synthetic spawn failed')
    expect(f.prepared.release).toHaveBeenCalledOnce()
  })
  it('releases the profile when downstream authority validation fails', async () => {
    const f = fixture('codex')
    f.service.validateLaunch.mockRejectedValue(new Error('synthetic authority failure'))
    const spawn = vi.spyOn(localProvider, 'spawn')
    await expect(
      run(f.deps, { cols: 80, rows: 24, command: 'codex', agentProfileId: 'a' })
    ).rejects.toThrow('synthetic authority failure')
    expect(spawn).not.toHaveBeenCalled()
    expect(f.prepared.release).toHaveBeenCalledOnce()
  })
})

it('reattaches an already materialized runtime pane without preparing a profile', async () => {
  const f = fixture('codex')
  const result = await spawnPtyFromRuntimeController(f.deps, {
    cols: 80,
    rows: 24,
    agentProfileId: 'deleted',
    adoptedStablePane: {
      materialized: true,
      result: { id: 'live' },
      owner: { ptyId: 'live', handle: 't1', tabId: 'tab', leafId: 'leaf' }
    }
  })
  expect(result.id).toBe('live')
  expect(f.service.prepareById).not.toHaveBeenCalled()
  expect(f.prepared.release).not.toHaveBeenCalled()
})

describe.each(['desktop', 'runtime'] as const)('%s daemon profile routing', (surface) => {
  it.each(['claude', 'codex'] as const)(
    'preserves an external %s home through daemon environment construction',
    async (agent) => {
      const original = localProvider
      // A synthetic persistent provider exercises the daemon branch without a daemon process.
      setLocalPtyProvider(new Proxy(original, { getPrototypeOf: () => Object.prototype }))
      try {
        const f = fixture(agent, true)
        const result = await launch(surface, f.deps, {
          cols: 80,
          rows: 24,
          command: agent,
          agentProfileId: 'a'
        })
        expect(result.options.env).toMatchObject(f.prepared.envPatch)
        expect(result.options.command).toContain('/external')
        expect(f.selected).not.toHaveBeenCalled()
        expect(f.resume).not.toHaveBeenCalled()
        expect(f.legacy).not.toHaveBeenCalled()
      } finally {
        setLocalPtyProvider(original)
      }
    }
  )
})

describe.skipIf(process.platform === 'win32').each(['desktop', 'runtime'] as const)(
  '%s shared external Claude ownership',
  (surface) => {
    const run = surface === 'desktop' ? runPtyIpcSpawn : spawnPtyFromRuntimeController
    async function withHome(
      operation: (f: ReturnType<typeof fixture>) => Promise<void>,
      independent = false
    ) {
      const root = mkdtempSync(join(tmpdir(), 'orca-profile-gate-'))
      const home = join(root, 'runtime')
      mkdirSync(home)
      const alias = join(root, 'alias')
      symlinkSync(home, alias)
      vi.stubEnv('CLAUDE_CONFIG_DIR', alias)
      const f = fixture('claude', true)
      f.prepared.snapshot.resolvedHome = realpathSync(independent ? root : home)
      f.prepared.envPatch.CLAUDE_CONFIG_DIR = f.prepared.snapshot.resolvedHome
      try {
        await operation(f)
      } finally {
        clearProviderPtyState('external-committed')
        attachClaudeLivePtyPersistence(null)
        rmSync(root, { recursive: true, force: true })
      }
    }
    it('transfers the shared pending lease, persists it, preserves reattach and releases on exit/recovery', async () => {
      await withHome(async (f) => {
        const add = vi.fn()
        const remove = vi.fn()
        attachClaudeLivePtyPersistence({
          addClaudeLivePtySessionId: add,
          removeClaudeLivePtySessionId: remove
        })
        const spawn = vi.spyOn(localProvider, 'spawn').mockImplementation(async () => {
          expect(hasLiveLegacyClaudePtys()).toBe(true)
          expect(hasLiveClaudePtys()).toBe(false)
          return { id: 'external-committed', pid: 123 }
        })
        await run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
        expect(hasLiveLegacyClaudePtys()).toBe(true)
        expect(add).toHaveBeenCalledWith('external-committed')
        expect(f.prepared.release).toHaveBeenCalledOnce()
        expect(f.legacy).not.toHaveBeenCalled()
        spawn.mockResolvedValue({ id: 'external-committed', isReattach: true })
        await run(f.deps, {
          cols: 80,
          rows: 24,
          sessionId: 'external-committed',
          agentProfileId: 'deleted'
        })
        expect(f.service.prepareById).toHaveBeenCalledOnce()
        expect(hasLiveLegacyClaudePtys()).toBe(true)
        clearProviderPtyState('external-committed')
        expect(hasClaudeCredentialOwners()).toBe(false)
        expect(remove).toHaveBeenCalledWith('external-committed')
        seedLiveClaudePtysFromPersistence(['external-committed'])
        confirmSeededClaudeLivePtys(['external-committed'])
        expect(hasLiveLegacyClaudePtys()).toBe(true)
        clearProviderPtyState('external-committed')
        seedLiveClaudePtysFromPersistence(['external-committed'])
        confirmSeededClaudeLivePtys([])
        expect(hasClaudeCredentialOwners()).toBe(false)
      })
    })
    it('releases the pending shared lease on provider refusal', async () => {
      await withHome(async (f) => {
        vi.spyOn(localProvider, 'spawn').mockImplementation(async () => {
          expect(hasLiveLegacyClaudePtys()).toBe(true)
          throw new Error('synthetic refusal')
        })
        await expect(
          run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
        ).rejects.toThrow('synthetic refusal')
        expect(hasClaudeCredentialOwners()).toBe(false)
        expect(f.prepared.release).toHaveBeenCalledOnce()
      })
    })
    it('does not resurrect ownership when the provider reports an exit before its spawn reply', async () => {
      await withHome(async (f) => {
        vi.spyOn(localProvider, 'spawn').mockResolvedValue({
          id: 'external-committed',
          exitedBeforeSpawnReply: true
        })
        await expect(
          run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
        ).rejects.toThrow('agent_session_exited_during_start')
        expect(hasClaudeCredentialOwners()).toBe(false)
        expect(f.prepared.release).toHaveBeenCalledOnce()
      })
    })
    it('does not assign the prepared profile to a reattach won during provider spawn', async () => {
      await withHome(async (f) => {
        vi.spyOn(localProvider, 'spawn').mockResolvedValue({
          id: 'external-committed',
          isReattach: true
        })
        await run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
        expect(hasClaudeCredentialOwners()).toBe(false)
        expect(f.prepared.release).toHaveBeenCalledOnce()
      })
    })
    it.each(['command', 'validation'] as const)(
      'releases shared ownership when %s preparation fails',
      async (failure) => {
        await withHome(async (f) => {
          if (failure === 'validation') {
            f.service.validateLaunch.mockRejectedValue(new Error('synthetic validation'))
          }
          const spawn = vi.spyOn(localProvider, 'spawn')
          await expect(
            run(f.deps, {
              cols: 80,
              rows: 24,
              command: 'claude',
              agentProfileId: 'a',
              ...(failure === 'command' ? { launchAgent: 'codex' as const } : {})
            })
          ).rejects.toThrow()
          expect(spawn).not.toHaveBeenCalled()
          expect(hasClaudeCredentialOwners()).toBe(false)
          expect(f.prepared.release).toHaveBeenCalledOnce()
        })
      }
    )
    it('keeps an independent external home outside the gate', async () => {
      await withHome(async (f) => {
        vi.spyOn(localProvider, 'spawn').mockImplementation(async () => {
          expect(hasClaudeCredentialOwners()).toBe(false)
          return { id: 'external-committed', pid: 123 }
        })
        await run(f.deps, { cols: 80, rows: 24, command: 'claude', agentProfileId: 'a' })
        expect(hasClaudeCredentialOwners()).toBe(false)
      }, true)
    })
  }
)
