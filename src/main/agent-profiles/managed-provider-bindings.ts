import { AgentProfilePreparationError } from './preparation-error'
import { reserveCodexProfileAccountOwner } from '../codex/codex-pane-account-registry'
import { validateManagedCodexProfileLaunch } from '../codex-accounts/profile-launch-preflight'
// Provider-owned account records and home gates are the only managed binding authority.
import type { Store } from '../persistence'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { resolveOwnedClaudeManagedAuthPath } from '../claude-accounts/managed-auth-path'
import { reserveClaudeCredentialOwner } from '../claude-accounts/live-pty-gate'
import { CLAUDE_PROFILE_PROVIDER_ENV_VARS } from '../claude-accounts/claude-profile-environment'
import { readManagedCodexProfileIdentity } from '../codex-accounts/independent-profile-home'
import { readManagedClaudeProfileIdentity } from '../claude-accounts/profile-identity'
import { validateManagedClaudeProfileLaunch } from '../claude-accounts/profile-launch-preflight'
import { createClaudeProfileAdapter, createCodexProfileAdapter } from './provider-adapters'

export type ManagedProfileServices = {
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  claudeRuntimeAuth: Pick<ClaudeRuntimeAuthService, 'prepareForClaudeProfileLaunch'>
  codexRuntimeHome: Pick<
    CodexRuntimeHomeService,
    'resolveCodexManagedAccountHomeForInactiveFetch' | 'prepareForCodexProfileLaunch'
  >
}

export function createManagedProfileAdapters(services: ManagedProfileServices) {
  async function claudeObservation(accountId: string) {
    const account = services.store
      .getSettings()
      .claudeManagedAccounts.find((entry) => entry.id === accountId)
    if (!account || account.managedAuthRuntime === 'wsl' || account.wslLinuxAuthPath) {
      throw new Error('A local managed Claude account is required.')
    }
    const home = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath)
    if (!home) {
      throw new Error('Managed Claude home is untrusted or unavailable.')
    }
    const identity = await readManagedClaudeProfileIdentity(account)
    return { home, identity }
  }
  function codexObservation(accountId: string) {
    const account = services.store
      .getSettings()
      .codexManagedAccounts.find((entry) => entry.id === accountId)
    if (!account || account.managedHomeRuntime === 'wsl' || account.wslLinuxHomePath) {
      throw new Error('A local managed Codex account is required.')
    }
    const resolved =
      services.codexRuntimeHome.resolveCodexManagedAccountHomeForInactiveFetch(account)
    if (resolved.kind !== 'ready') {
      throw new Error('Managed Codex home is untrusted or unavailable.')
    }
    const identity = readManagedCodexProfileIdentity(resolved.homePath, account)
    return {
      home: resolved.homePath,
      identity: {
        kind: 'verified' as const,
        subject: JSON.stringify([
          'codex',
          identity.email,
          identity.providerAccountId,
          identity.workspaceAccountId
        ]),
        displayName: identity.email!
      }
    }
  }
  return {
    claude: createClaudeProfileAdapter({
      validateLaunch: validateManagedClaudeProfileLaunch,
      inspectManaged: claudeObservation,
      prepareManaged: async (id) => {
        const release = reserveClaudeCredentialOwner(true)
        try {
          const observed = await claudeObservation(id)
          if (observed.identity.kind !== 'verified') {
            throw new AgentProfilePreparationError('claude_identity')
          }
          const auth = await services.claudeRuntimeAuth.prepareForClaudeProfileLaunch(id, {
            runtime: 'host'
          })
          if (
            !auth.isolatedCredentials ||
            auth.configDir !== observed.home ||
            JSON.stringify((await claudeObservation(id)).identity) !==
              JSON.stringify(observed.identity)
          ) {
            throw new Error('Managed Claude preparation did not retain its owned home.')
          }
          return {
            home: auth.configDir,
            envPatch: auth.envPatch,
            envToDelete: [...CLAUDE_PROFILE_PROVIDER_ENV_VARS],
            release
          }
        } catch (error) {
          release()
          throw error
        }
      }
    }),
    codex: createCodexProfileAdapter({
      validateLaunch: validateManagedCodexProfileLaunch,
      inspectManaged: async (id) => codexObservation(id),
      prepareManaged: async (id) => {
        const release = reserveCodexProfileAccountOwner(id)
        try {
          const home = await services.codexRuntimeHome.prepareForCodexProfileLaunch(id)
          return { home, envPatch: { CODEX_HOME: home }, envToDelete: [], release }
        } catch (error) {
          release()
          throw error
        }
      }
    })
  }
}
