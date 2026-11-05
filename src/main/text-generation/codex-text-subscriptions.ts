import { captureCodexProjectConfiguration } from './codex-project-configuration'
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
import { readCodexTextConfiguration } from './codex-text-configuration'
import { prepareCodexTextGenerationHooks } from '../codex/codex-text-hook-preparation'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { Store } from '../persistence/loading-store/store'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  readCodexSubscriptionIdentity,
  readCodexSubscriptionObservation
} from '../rate-limits/codex-subscription-observation'
import { resolveCodexCommand } from '../codex-cli/command'
import { parseCodexModels } from '../../shared/commit-message-model-parsers'
import {
  withCodexHomeProcessLock,
  resolveCodexHomeProcessLockKey
} from '../codex-cli/codex-home-process-lock'
import type { PrepareTextSubscriptionFailover } from './text-subscription-failover'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

function capacity(limits: ProviderRateLimits | null | undefined) {
  return providerTextAccountCapacity(limits, readCodexSubscriptionObservation(limits)?.observedAt)
}

export function createCodexTextSubscriptionPreparation(deps: {
  store: Pick<Store, 'getSettings'>
  home: Pick<CodexRuntimeHomeService, 'prepareManagedAccountForTextGeneration'>
  rateLimits: Pick<RateLimitService, 'getState' | 'refreshTextSubscriptionAccounts'>
}): PrepareTextSubscriptionFailover {
  return ({ params, cwd, env, request }) => {
    const settings = deps.store.getSettings()
    if (
      params.agentId !== 'codex' ||
      settings.textGenerationSubscriptionFailoverEnabled !== true ||
      params.agentCommandOverride ||
      params.customAgentCommand ||
      params.agentArgs?.trim() ||
      resolveLocalAccountRuntimeTarget(settings).runtime !== 'host' ||
      parseWslUncPath(cwd)
    ) {
      return undefined
    }
    if (
      Object.keys(env).some(
        (k) =>
          env[k] &&
          /^(OPENAI_|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_CONFIG|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_OPTIONS)/i.test(
            k
          )
      )
    ) {
      return undefined
    }
    if (env.CODEX_HOME && env.CODEX_HOME !== env.ORCA_CODEX_HOME) {
      return undefined
    }
    const initialAccountId = getSelectedCodexAccountIdForTarget(settings, { runtime: 'host' })
    if (!initialAccountId) {
      return undefined
    }
    const accounts = settings.codexManagedAccounts.filter(
      (a) => a.managedHomeRuntime !== 'wsl' && a.providerAccountId
    )
    const project = captureCodexProjectConfiguration(cwd, env)
    const settingsCurrent = createSettingsFence(
      () => deps.store.getSettings(),
      [
        'textGenerationSubscriptionFailoverEnabled',
        'codexManagedAccounts',
        'activeCodexManagedAccountId',
        'activeCodexManagedAccountIdsByRuntime',
        'agentStatusHooksEnabled',
        'disabledTuiAgents',
        ...LOCAL_ACCOUNT_RUNTIME_SETTINGS_KEYS
      ],
      (latest) => [
        latest.textGenerationSubscriptionFailoverEnabled,
        latest.codexManagedAccounts,
        getSelectedCodexAccountIdForTarget(latest, { runtime: 'host' }),
        resolveLocalAccountRuntimeTarget(latest),
        isAgentStatusHooksEnabledForAgent(latest, 'codex')
      ]
    )
    const current = () => request.current() && settingsCurrent() && project.current()
    const usage = (id: string) => {
      const state = deps.rateLimits.getState()
      return id === initialAccountId
        ? state.codex
        : state.inactiveCodexAccounts?.find((a) => a.accountId === id)?.rateLimits
    }
    const base = { ...env }
    delete base.CODEX_HOME
    delete base.ORCA_CODEX_HOME
    const binary = resolveCodexCommand({ pathEnv: base.PATH ?? base.Path ?? null })
    let versionChecked = false
    let fixedConfig: string | undefined
    const probe = createTextSubscriptionCliProbe({ program: binary, cwd, request, current })
    const rank = () =>
      rankTextAccountsByCapacity(
        accounts.filter((a) => a.id !== initialAccountId).map((a) => a.id),
        (id) => capacity(usage(id))
      )
    let refreshed = false
    const refresh = async () => {
      if (refreshed) {
        return
      }
      refreshed = true
      await deps.rateLimits.refreshTextSubscriptionAccounts('codex', request.signal)
    }
    return {
      params: Object.freeze({ ...params }),
      current: current,
      initialAccountId,
      candidates: async () => {
        const cached = rank()
        if (cached.length || refreshed) {
          return cached
        }
        await refresh()
        return current() ? rank() : []
      },
      confirmQuota: async (attempt) => {
        const confirmed = () => {
          const receipt = readCodexSubscriptionObservation(usage(attempt.accountId))
          const identity = readCodexSubscriptionIdentity(attempt.env.CODEX_HOME!)
          return (
            current() &&
            capacity(usage(attempt.accountId)) === 0 &&
            receipt?.identity === attempt.identity &&
            identity?.identity === attempt.identity &&
            identity.credentialRevision === receipt.credentialRevision
          )
        }
        if (confirmed()) {
          return true
        }
        await refresh()
        return confirmed()
      },
      prepare: async (id) => {
        const account = accounts.find((a) => a.id === id)
        const observed = readCodexSubscriptionObservation(usage(id))
        if (
          !account ||
          !current() ||
          (id !== initialAccountId && (!observed || (capacity(usage(id)) ?? 0) <= 0)) ||
          !(await project.revalidate())
        ) {
          return null
        }
        return withCodexHomeProcessLock(
          resolveCodexHomeProcessLockKey(account.managedHomePath),
          async () => {
            if (!current()) {
              return null
            }
            const home = deps.home.prepareManagedAccountForTextGeneration(
              id,
              (home) => readCodexTextConfiguration(home) !== null
            )
            if (!home) {
              return null
            }
            const hookStatus = await prepareCodexTextGenerationHooks(
              home,
              () => isAgentStatusHooksEnabledForAgent(deps.store.getSettings(), 'codex'),
              () => current() && readCodexTextConfiguration(home) !== null
            )
            if (!hookStatus || hookStatus.state === 'error' || !current()) {
              return null
            }
            const identity = readCodexSubscriptionIdentity(home)
            if (
              !identity ||
              (id !== initialAccountId &&
                (identity.home !== observed?.home ||
                  identity.identity !== observed.identity ||
                  identity.credentialRevision !== observed.credentialRevision)) ||
              identity.identity !==
                JSON.stringify([account.providerAccountId, account.workspaceAccountId ?? null])
            ) {
              return null
            }
            const receipt = identity
            const config = readCodexTextConfiguration(home)
            if (
              config === null ||
              (fixedConfig !== undefined && config.comparable !== fixedConfig)
            ) {
              return null
            }
            const launchEnv = { ...base, CODEX_HOME: home }
            if (!versionChecked) {
              if (
                !supportsTextSubscriptionCliVersion(
                  'Codex',
                  await readTextSubscriptionCliVersion(binary, () =>
                    probe(['--version'], launchEnv)
                  ),
                  /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/,
                  '0.166.0'
                )
              ) {
                return null
              }
              versionChecked = true
            }
            const models = await readTextSubscriptionModelListing({
              program: binary,
              accountId: id,
              identity: receipt.identity,
              configuration: config.comparable,
              cwd,
              probe: () => probe(['debug', 'models'], launchEnv),
              parse: (output) => nonEmptyModelListing(parseCodexModels(output))
            })
            const model = models?.find((m) => m.id === params.model)
            if (
              !current() ||
              !model ||
              (params.thinkingLevel &&
                !model.thinkingLevels?.some((e) => e.id === params.thinkingLevel))
            ) {
              return null
            }
            fixedConfig = config.comparable
            // A refreshed auth.json stays usable once the same home still proves the same account.
            const spawnAllowed = () => {
              if (!current()) {
                return false
              }
              const latestConfig = readCodexTextConfiguration(home)
              const latestIdentity = readCodexSubscriptionIdentity(home)
              return (
                (id === initialAccountId ||
                  ((capacity(usage(id)) ?? 0) > 0 &&
                    readCodexSubscriptionObservation(usage(id))?.identity === receipt.identity)) &&
                latestIdentity?.identity === receipt.identity &&
                latestIdentity.home === receipt.home &&
                latestConfig?.raw === config.raw &&
                latestConfig.hooksRaw === config.hooksRaw
              )
            }
            const valid = async () => (await project.revalidate()) && spawnAllowed()
            return {
              accountId: id,
              identity: receipt.identity,
              model: model.id,
              env: launchEnv,
              valid,
              spawnAllowed,
              configurePlan: (plan) => ({
                ...plan,
                args: [...plan.args, '--json'],
                outputFormat: 'codex-subscription-json',
                subscriptionQuotaExhausted: capacity(usage(id)) === 0
              })
            }
          }
        )
      }
    }
  }
}
