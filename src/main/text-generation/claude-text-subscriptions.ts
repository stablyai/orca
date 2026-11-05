import { providerTextAccountCapacity, rankTextAccountsByCapacity } from './text-account-capacity'
import {
  createSettingsFence,
  LOCAL_ACCOUNT_RUNTIME_SETTINGS_KEYS
} from './text-generation-settings-fence'
import {
  createTextSubscriptionCliProbe,
  nonEmptyModelListing,
  readTextSubscriptionCliVersion,
  readTextSubscriptionModelListing,
  supportsTextSubscriptionCliVersion
} from './text-subscription-cli-probe'
import { claudeTextConfiguration, forbiddenClaudeEnvironment } from './claude-text-configuration'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { Store } from '../persistence/loading-store/store'
import type { RateLimitService } from '../rate-limits/service'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'
import { readClaudeOAuthCredentials } from '../rate-limits/claude-oauth-credentials'
import {
  readClaudeSubscriptionObservation,
  claudeSubscriptionIdentity,
  isSameClaudeSubscriptionHome
} from '../rate-limits/claude-subscription-observation'
import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN,
  parseClaudeModelList
} from '../../shared/claude-model-list-probe'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type {
  PrepareTextSubscriptionFailover,
  TextSubscriptionAttempt
} from './text-subscription-failover'

function capacity(limits: ProviderRateLimits | null | undefined) {
  const receipt = readClaudeSubscriptionObservation(limits)
  return providerTextAccountCapacity(
    limits,
    receipt?.windowsComplete ? receipt.observedAt : undefined
  )
}

export function createClaudeTextSubscriptionPreparation(deps: {
  store: Pick<Store, 'getSettings'>
  auth: Pick<ClaudeRuntimeAuthService, 'prepareAccountFolder' | 'router'>
  rateLimits: Pick<RateLimitService, 'getState' | 'refreshTextSubscriptionAccounts'>
}): PrepareTextSubscriptionFailover {
  return ({ params, cwd, env, request }) => {
    const settings = deps.store.getSettings()
    if (
      settings.textGenerationSubscriptionFailoverEnabled !== true ||
      params.agentId !== 'claude' ||
      params.agentArgs?.trim() ||
      params.agentCommandOverride ||
      params.customAgentCommand ||
      Object.keys(env).some((key) => env[key] && forbiddenClaudeEnvironment.test(key))
    ) {
      return undefined
    }
    const initialAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
    if (resolveLocalAccountRuntimeTarget(settings).runtime !== 'host' || parseWslUncPath(cwd)) {
      return undefined
    }
    if (!initialAccountId || deps.auth.router.coveredBySystemDefault(initialAccountId)) {
      return undefined
    }
    if (
      env.ORCA_CLAUDE_USER_CONFIG_DIR ||
      (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== env.ORCA_CLAUDE_INJECTED_CONFIG_DIR)
    ) {
      return undefined
    }
    const accounts = settings.claudeManagedAccounts.filter(
      (a) => a.authMethod === 'subscription-oauth' && a.managedAuthRuntime !== 'wsl'
    )
    const settingsCurrent = createSettingsFence(
      () => deps.store.getSettings(),
      [
        'textGenerationSubscriptionFailoverEnabled',
        'claudeManagedAccounts',
        'activeClaudeManagedAccountId',
        'activeClaudeManagedAccountIdsByRuntime',
        ...LOCAL_ACCOUNT_RUNTIME_SETTINGS_KEYS
      ],
      (latest) => [
        latest.textGenerationSubscriptionFailoverEnabled,
        latest.claudeManagedAccounts,
        getSelectedClaudeAccountIdForTarget(latest, { runtime: 'host' }),
        resolveLocalAccountRuntimeTarget(latest)
      ]
    )
    const stillCurrent = () => request.current() && settingsCurrent()
    const base = { ...env }
    for (const key of Object.keys(base)) {
      if (/^(CLAUDE_CONFIG_DIR|ORCA_CLAUDE_.*)$/i.test(key)) {
        delete base[key]
      }
    }
    const binary = resolveClaudeCommand({ pathEnv: base.PATH ?? base.Path ?? null })
    let versionChecked = false
    let frozenModel: string | undefined
    let frozenConfiguration: string | undefined
    const probe = createTextSubscriptionCliProbe({
      program: binary,
      cwd,
      request,
      current: stillCurrent
    })
    const usage = (id: string) => {
      const state = deps.rateLimits.getState()
      return id === initialAccountId
        ? state.claude
        : state.inactiveClaudeAccounts?.find((a) => a.accountId === id)?.rateLimits
    }
    const rank = () =>
      rankTextAccountsByCapacity(
        accounts
          .filter(
            (a) => a.id !== initialAccountId && !deps.auth.router.coveredBySystemDefault(a.id)
          )
          .map((a) => a.id),
        (id) => capacity(usage(id))
      )
    let refreshed = false
    return {
      params: Object.freeze({ ...params }),
      current: stillCurrent,
      initialAccountId,
      candidates: async () => {
        const cached = rank()
        if (cached.length || refreshed) {
          return cached
        }
        refreshed = true
        await deps.rateLimits.refreshTextSubscriptionAccounts('claude', request.signal)
        return stillCurrent() ? rank() : []
      },
      prepare: async (accountId): Promise<TextSubscriptionAttempt | null> => {
        const account = accounts.find((a) => a.id === accountId)
        const limits = usage(accountId)
        const observed = readClaudeSubscriptionObservation(limits)
        if (
          !account ||
          !stillCurrent() ||
          (accountId !== initialAccountId && ((capacity(limits) ?? 0) <= 0 || !observed))
        ) {
          return null
        }
        const folder = await deps.auth.prepareAccountFolder(accountId, { runtime: 'host' })
        if (!stillCurrent()) {
          return null
        }
        const credentials = await readClaudeOAuthCredentials({
          credentialsFileConfigDir: folder.configDir,
          keychainConfigDir: folder.configDir,
          unsuffixedKeychainFallback: false
        })
        const identity = credentials.token
          ? await claudeSubscriptionIdentity(folder.configDir, credentials.token)
          : null
        if (
          !identity ||
          (accountId !== initialAccountId &&
            (!isSameClaudeSubscriptionHome(identity.home, observed?.home) ||
              identity.identity !== observed?.identity ||
              identity.credentialRevision !== observed.credentialRevision)) ||
          identity.identity !==
            JSON.stringify([account.email.toLowerCase(), account.organizationUuid])
        ) {
          return null
        }
        const receipt = identity
        const config = await claudeTextConfiguration(folder.configDir, cwd)
        if (
          !stillCurrent() ||
          config === null ||
          (frozenConfiguration !== undefined && frozenConfiguration !== config)
        ) {
          return null
        }
        const launchEnv = { ...base, CLAUDE_CONFIG_DIR: folder.configDir }
        if (!versionChecked) {
          if (
            !supportsTextSubscriptionCliVersion(
              'Claude',
              await readTextSubscriptionCliVersion(binary, () => probe(['--version'], launchEnv)),
              /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(Claude Code\)$/,
              '2.1.317'
            )
          ) {
            return null
          }
          versionChecked = true
        }
        const models = await readTextSubscriptionModelListing({
          program: binary,
          accountId,
          identity: receipt.identity,
          configuration: config,
          cwd,
          probe: () => probe(CLAUDE_MODEL_LIST_ARGS, launchEnv, CLAUDE_MODEL_LIST_STDIN),
          parse: (output) => nonEmptyModelListing(parseClaudeModelList(output))
        })
        const model = models?.find((m) => m.id === params.model || m.resolvedModel === params.model)
        if (
          !stillCurrent() ||
          !model?.resolvedModel ||
          !/^claude-(sonnet|haiku)-[a-z0-9.-]+$/.test(model.resolvedModel) ||
          (frozenModel && frozenModel !== model.resolvedModel)
        ) {
          return null
        }
        frozenModel = model.resolvedModel
        frozenConfiguration = config
        const modelId = frozenModel
        return {
          accountId,
          identity: receipt.identity,
          model: modelId,
          env: launchEnv,
          configurePlan: (plan) => {
            const args = [...plan.args]
            args[args.indexOf('--output-format') + 1] = 'stream-json'
            args.push('--verbose')
            return { ...plan, args, outputFormat: 'claude-subscription-stream-json' }
          },
          valid: async () => {
            const currentCredentials = await readClaudeOAuthCredentials({
              credentialsFileConfigDir: folder.configDir,
              keychainConfigDir: folder.configDir,
              unsuffixedKeychainFallback: false
            })
            const currentIdentity = currentCredentials.token
              ? await claudeSubscriptionIdentity(folder.configDir, currentCredentials.token)
              : null
            const limits = usage(accountId)
            // A refreshed token stays usable once the same home still proves the same login.
            return (
              stillCurrent() &&
              (accountId === initialAccountId ||
                ((capacity(limits) ?? 0) > 0 &&
                  readClaudeSubscriptionObservation(limits)?.identity === receipt.identity)) &&
              currentIdentity?.identity === receipt.identity &&
              isSameClaudeSubscriptionHome(currentIdentity.home, receipt.home) &&
              (await claudeTextConfiguration(folder.configDir, cwd)) === frozenConfiguration
            )
          }
        }
      }
    }
  }
}
