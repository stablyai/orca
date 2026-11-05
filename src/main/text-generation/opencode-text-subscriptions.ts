import type { OpenCodeCredentialBackend } from '../opencode/opencode-credential-backend'
import { currentTextAccountCapacity, rankTextAccountsByCapacity } from './text-account-capacity'
import {
  createSettingsFence,
  LOCAL_ACCOUNT_RUNTIME_SETTINGS_KEYS
} from './text-generation-settings-fence'
import {
  createTextSubscriptionCliProbe,
  nonEmptyModelListing,
  readTextSubscriptionCliVersion,
  readTextSubscriptionModelListing
} from './text-subscription-cli-probe'
import { directoriesUpToRoot, readOptionalConfigFile } from './claude-text-configuration'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { resolveCliCommand } from '../codex-cli/command'
import { parseLineModels } from '../../shared/commit-message-model-parsers'
import { createHash } from 'node:crypto'
import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { environmentForStructuredOpenCodeAccountHome } from '../opencode/opencode-structured-account-home'
import { resolveOpenCodeGoApiKey } from '../rate-limits/opencode-go-api-key-source'
import type { RateLimitService } from '../rate-limits/service'
import type { Store } from '../persistence/loading-store/store'
import type { PrepareTextSubscriptionFailover } from './text-subscription-failover'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import type { OpenCodeTextAccountUsage } from '../rate-limits/service/service-opencode-text-accounts'

function capacity(usage: OpenCodeTextAccountUsage | undefined) {
  return usage
    ? currentTextAccountCapacity(usage.observedAt, [
        usage.windows.session,
        usage.windows.weekly,
        ...(usage.windows.monthly ? [usage.windows.monthly] : [])
      ])
    : null
}

async function configuration(env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  const global = join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode')
  const files = [join(global, 'opencode.json'), join(global, 'opencode.jsonc')]
  for (const directory of directoriesUpToRoot(cwd)) {
    files.push(
      join(directory, 'opencode.json'),
      join(directory, 'opencode.jsonc'),
      join(directory, '.opencode', 'opencode.json'),
      join(directory, '.opencode', 'opencode.jsonc')
    )
  }
  try {
    const contents = await Promise.all(files.map(readOptionalConfigFile))
    for (const content of contents) {
      if (content === null) {
        continue
      }
      const errors: ParseError[] = []
      const config = parseJsonc(content, errors, { allowTrailingComma: true })
      if (
        errors.length ||
        config?.provider?.['opencode-go'] ||
        config?.plugin?.length ||
        (config?.mcp !== undefined &&
          (config.mcp === null ||
            typeof config.mcp !== 'object' ||
            Array.isArray(config.mcp) ||
            Object.keys(config.mcp).length > 0))
      ) {
        return null
      }
    }
    return JSON.stringify(contents)
  } catch {
    return null
  }
}

export function createOpenCodeTextSubscriptionPreparation(deps: {
  store: Pick<Store, 'getSettings'>
  rateLimits: Pick<RateLimitService, 'getOpenCodeTextAccountUsage' | 'refreshOpenCodeTextAccounts'>
}): PrepareTextSubscriptionFailover {
  return ({ params, cwd, env, request }) => {
    const settings = deps.store.getSettings()
    if (
      !['opencode', 'opencode2'].includes(params.agentId) ||
      settings.textGenerationSubscriptionFailoverEnabled !== true ||
      !params.model.startsWith('opencode-go/') ||
      params.agentCommandOverride ||
      params.agentArgs?.trim() ||
      params.customAgentCommand ||
      parseWslUncPath(cwd) ||
      resolveLocalAccountRuntimeTarget(settings).runtime !== 'host'
    ) {
      return undefined
    }
    if (
      Object.keys(env).some(
        (k) =>
          env[k] &&
          /^(OPENCODE_(CONFIG|AUTH|API|SERVER)|ZEN_API_KEY|ORCA_DATA_ACCOUNT_ID|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(
            k
          )
      )
    ) {
      return undefined
    }
    const accounts = getManagedDataAccountService()
    const state = accounts.list('opencode')
    const initialAccountId = state.activeAccountId
    if (!initialAccountId) {
      return undefined
    }
    const revision = accounts.revision
    const settingsCurrent = createSettingsFence(
      () => deps.store.getSettings(),
      ['textGenerationSubscriptionFailoverEnabled', ...LOCAL_ACCOUNT_RUNTIME_SETTINGS_KEYS],
      (latest) => [
        latest.textGenerationSubscriptionFailoverEnabled,
        resolveLocalAccountRuntimeTarget(latest)
      ]
    )
    const current = () => request.current() && settingsCurrent() && accounts.revision === revision
    const binary = resolveCliCommand(params.agentId, { pathEnv: env.PATH ?? env.Path ?? null })
    const fixedConfig = configuration(env, cwd)
    const probe = createTextSubscriptionCliProbe({ program: binary, cwd, request, current })
    let backend: OpenCodeCredentialBackend | undefined
    let refreshed = false
    const usage = (id: string) =>
      backend ? deps.rateLimits.getOpenCodeTextAccountUsage(id, backend) : undefined
    // Only a refresh that actually ran spends this request's single refresh.
    const refresh = async (accountIds: string[]) => {
      if (refreshed || !backend) {
        return
      }
      refreshed = await deps.rateLimits.refreshOpenCodeTextAccounts({
        signal: request.signal,
        backend,
        environment: env,
        cwd,
        accountIds,
        freshUntil: request.deadline
      })
    }
    const alternates = state.accounts.filter((a) => a.id !== initialAccountId).map((a) => a.id)
    const rank = () => rankTextAccountsByCapacity(alternates, (id) => capacity(usage(id)))
    return {
      params: Object.freeze({ ...params }),
      current: current,
      initialAccountId,
      candidates: async () => {
        const cached = rank()
        if (cached.length || refreshed) {
          return cached
        }
        await refresh(alternates)
        return current() ? rank() : []
      },
      prepare: async (id) => {
        if ((await fixedConfig) === null || !current()) {
          return null
        }
        const launchEnv = environmentForStructuredOpenCodeAccountHome(
          { kind: 'opencode', locator: { kind: 'managed', managedProfileId: id } },
          { managedAccounts: accounts, baseEnvironment: env }
        )
        if (!backend) {
          const version = (
            await readTextSubscriptionCliVersion(binary, () => probe(['--version'], launchEnv))
          )?.trim()
          if (!version || !/^(?:opencode\s+)?v?[12]\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
            return null
          }
          backend = /^(?:opencode\s+)?v?1\./.test(version) ? 'v1' : 'v2'
        }
        // Usage that would expire before the request deadline is refreshed once per request.
        await refresh([id])
        if (!current() || capacity(usage(id)) === null) {
          return null
        }
        const receipt = usage(id)!
        const credentials = await resolveOpenCodeGoApiKey({ environment: launchEnv, cwd, backend })
        if (
          credentials.status !== 'found' ||
          createHash('sha256').update(credentials.key).digest('hex') !== receipt.credentialRevision
        ) {
          return null
        }
        const models = await readTextSubscriptionModelListing({
          program: binary,
          accountId: id,
          identity: receipt.credentialRevision,
          configuration: (await fixedConfig) ?? '',
          cwd,
          probe: () => probe(['models', 'opencode-go'], launchEnv),
          parse: (output) => nonEmptyModelListing(parseLineModels(output))
        })
        if (!current() || !models?.some((m) => m.id === params.model)) {
          return null
        }
        const valid = async () => {
          const fresh = await resolveOpenCodeGoApiKey({ environment: launchEnv, cwd, backend })
          return (
            current() &&
            (await configuration(env, cwd)) === (await fixedConfig) &&
            (id === initialAccountId
              ? capacity(usage(id)) !== null
              : (capacity(usage(id)) ?? 0) > 0) &&
            fresh.status === 'found' &&
            createHash('sha256').update(fresh.key).digest('hex') === receipt.credentialRevision
          )
        }
        return {
          accountId: id,
          identity: receipt.credentialRevision,
          model: params.model,
          env: launchEnv,
          valid,
          configurePlan: (plan) => ({ ...plan, outputFormat: 'opencode-subscription-json' })
        }
      }
    }
  }
}
