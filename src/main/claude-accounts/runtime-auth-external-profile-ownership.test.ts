import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type * as Os from 'node:os'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from './oauth-refresh'
import type { PreparedAgentProfile } from '../agent-profiles/connection-service'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof Os>('node:os')),
  homedir: () => testState.fakeHomeDir
}))

function external(home: string): PreparedAgentProfile {
  return {
    snapshot: {
      id: 'external',
      name: 'External',
      agent: 'claude',
      hostId: 'local',
      executable: '/synthetic/claude',
      binding: { kind: 'external', home },
      resolvedHome: home,
      identity: { kind: 'unverified', reason: 'synthetic' }
    },
    envPatch: { CLAUDE_CONFIG_DIR: home },
    envToDelete: [],
    release: vi.fn()
  }
}

const releases: (() => void)[] = []
async function prepareExternal(home: string) {
  const { prepareTerminalProfileLaunch } = await import('../ipc/pty/host-env/agent-profile-launch')
  const prepared = external(home)
  const result = await prepareTerminalProfileLaunch(
    { agentProfileId: 'external', command: 'claude' },
    {
      reattach: false,
      resume: false,
      isWsl: false,
      service: {
        prepare: async () => prepared,
        prepareById: async () => prepared,
        validateLaunch: async () => {}
      }
    }
  )
  releases.push(result!.release)
  return result!
}
beforeEach(() => {
  resetRuntimeAuthTestState()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.mocked(isOauthTokenExpiring).mockReturnValue(false)
  vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(null)
})
afterEach(async () => {
  const { markClaudePtyExited } = await import('./live-pty-gate')
  markClaudePtyExited('external-live')
  for (const release of releases.splice(0)) {
    release()
  }
  vi.unstubAllEnvs()
  cleanupRuntimeAuthTestState()
})

async function runtimeAuth() {
  const expired = createClaudeCredentialsJson('synthetic@example.com', 'expired', null, 1000)
  const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', expired)
  const store = createStore(
    createSettings({
      claudeManagedAccounts: [createClaudeAccount('account-1', managedAuthPath)],
      activeClaudeManagedAccountId: 'account-1'
    })
  )
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  const service = new ClaudeRuntimeAuthService(store)
  await service.syncForCurrentSelection()
  vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
  vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(
    createClaudeCredentialsJson('synthetic@example.com', 'refreshed')
  )
  return {
    service,
    expired,
    gate: await import('./live-pty-gate'),
    commitAgentProfilePtyOwnership: (await import('../ipc/pty/host-env/agent-profile-ownership'))
      .commitAgentProfilePtyOwnership
  }
}

describe('external Claude runtime credential ownership', () => {
  it.each(['default', 'alias', 'relative'] as const)(
    'defers actual legacy auth refresh for a live %s home until exit',
    async (homeKind) => {
      const { service, expired, gate, commitAgentProfilePtyOwnership } = await runtimeAuth()
      const home = join(testState.fakeHomeDir, '.claude')
      if (homeKind === 'alias') {
        const alias = join(testState.fakeHomeDir, 'runtime-alias')
        symlinkSync(home, alias)
        vi.stubEnv('CLAUDE_CONFIG_DIR', alias)
      } else if (homeKind === 'relative') {
        vi.stubEnv('CLAUDE_CONFIG_DIR', relative(process.cwd(), home))
      }
      const prepared = await prepareExternal(home)
      expect((await service.prepareForRateLimitFetch()).managedRefreshDeferredByLivePty).toBe(true)
      expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
      commitAgentProfilePtyOwnership(prepared, { id: 'external-live' })
      prepared.release()
      const preparation = await service.prepareForRateLimitFetch()
      expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
      expect(gate.hasLiveLegacyClaudePtys()).toBe(true)
      expect(preparation.managedRefreshDeferredByLivePty).toBe(true)
      expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(expired)
      gate.markClaudePtyExited('external-live')
      await service.prepareForRateLimitFetch()
      expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce()
    }
  )

  it('preserves relative symlink-parent directory identity during ownership classification', async () => {
    const { gate, commitAgentProfilePtyOwnership } = await runtimeAuth()
    const home = join(testState.fakeHomeDir, '.claude')
    const child = join(home, 'child')
    mkdirSync(child)
    const alias = join(testState.fakeHomeDir, 'runtime-alias')
    symlinkSync(child, alias)
    vi.stubEnv('CLAUDE_CONFIG_DIR', `${relative(process.cwd(), alias)}${sep}..`)
    const prepared = await prepareExternal(home)
    expect(gate.shouldDeferClaudeRuntimeRefresh()).toBe(true)
    commitAgentProfilePtyOwnership(prepared, { id: 'external-live' })
    prepared.release()
    expect(gate.hasLiveLegacyClaudePtys()).toBe(true)
  })

  it('defers while preparation is pending and wakes refresh when the launch is cancelled', async () => {
    const { service, gate } = await runtimeAuth()
    const prepared = await prepareExternal(join(testState.fakeHomeDir, '.claude'))
    const onDrained = vi.fn()
    const unsubscribe = gate.onLiveClaudePtysDrained(onDrained)
    try {
      expect((await service.prepareForRateLimitFetch()).managedRefreshDeferredByLivePty).toBe(true)
      expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
      prepared.release()
      expect(gate.hasClaudeCredentialOwners()).toBe(false)
      expect(onDrained).toHaveBeenCalledOnce()
      prepared.release()
      expect(onDrained).toHaveBeenCalledOnce()
      expect((await service.prepareForRateLimitFetch()).managedRefreshDeferredByLivePty).toBe(false)
      expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
    }
  })

  it.each([false, true])(
    'preserves legacy prelaunch refresh unless a shared external acquisition owns the home: %s',
    async (externalPending) => {
      const { service, gate } = await runtimeAuth()
      if (externalPending) {
        await prepareExternal(join(testState.fakeHomeDir, '.claude'))
      }
      const { prepareClaudeTerminalAuth } = await import('../ipc/pty/host-env/claude-launch-auth')
      const result = await prepareClaudeTerminalAuth({
        isClaudeLaunch: true,
        reattach: false,
        command: 'claude',
        resumesConversation: false,
        target: { runtime: 'host' },
        prepare: async (target) => {
          expect(gate.hasClaudeCredentialOwners()).toBe(true)
          return service.prepareForClaudeLaunch(target)
        }
      })
      releases.push(result.release!)
      expect(result.auth?.managedRefreshDeferredByLivePty).toBe(externalPending)
      expect(refreshClaudeOauthCredentials).toHaveBeenCalledTimes(externalPending ? 0 : 1)
    }
  )

  it('does not attribute an adopted process to a newly prepared external profile', async () => {
    const { service, gate, commitAgentProfilePtyOwnership } = await runtimeAuth()
    const prepared = await prepareExternal(join(testState.fakeHomeDir, '.claude'))
    commitAgentProfilePtyOwnership(prepared, {
      id: 'external-live',
      agentSessionEnsure: {
        disposition: 'adopted',
        owner: {
          ptyId: 'external-live',
          generation: 'generation',
          phase: 'live',
          claim: {
            digestVersion: 1,
            keyId: 'key',
            identityDigest: 'identity',
            worktreeScopeDigest: 'scope',
            agent: 'claude'
          },
          surface: { worktreeId: 'work', tabId: 'tab', leafId: 'leaf', terminalHandle: 't1' }
        }
      }
    })
    prepared.release()
    expect(gate.hasClaudeCredentialOwners()).toBe(false)
    await service.prepareForRateLimitFetch()
    expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce()
  })

  it.each(['default', 'relative'] as const)(
    'does not block refresh for an independent external home with %s runtime paths',
    async (runtimePaths) => {
      const { service, gate, commitAgentProfilePtyOwnership } = await runtimeAuth()
      if (runtimePaths === 'relative') {
        vi.stubEnv(
          'CLAUDE_CONFIG_DIR',
          relative(process.cwd(), join(testState.fakeHomeDir, '.claude'))
        )
      }
      const home = join(testState.fakeHomeDir, 'independent')
      mkdirSync(home)
      commitAgentProfilePtyOwnership(await prepareExternal(home), { id: 'external-live' })
      expect(gate.hasLiveLegacyClaudePtys()).toBe(false)
      await service.prepareForRateLimitFetch()
      expect(refreshClaudeOauthCredentials).toHaveBeenCalledOnce()
    }
  )
})
