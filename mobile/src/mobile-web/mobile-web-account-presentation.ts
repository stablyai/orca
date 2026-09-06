import {
  MOBILE_WEB_ACCOUNT_LIMIT,
  MobileWebAccountEventSchema,
  MobileWebAccountsSnapshotSchema,
  type MobileWebAccountEvent,
  type MobileWebAccountsSnapshot
} from '../../../src/shared/mobile-web/account-operation-contract'
import {
  mobileWebInactiveAccountUsage,
  mobileWebProviderRateLimits
} from './mobile-web-account-rate-limit-presentation'

type Provider = 'claude' | 'codex'
type RuntimeTarget = { runtime: 'host' | 'wsl'; wslDistro: string | null }

const HOST_TARGET: RuntimeTarget = { runtime: 'host', wslDistro: null }

export function mobileWebAccountsSnapshot(value: unknown): MobileWebAccountsSnapshot {
  if (!isRecord(value) || !isRecord(value.claude) || !isRecord(value.codex)) {
    throw new Error('mobile_web_accounts_snapshot_invalid')
  }
  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : {}
  const claudeTarget = runtimeTarget(rateLimits.claudeTarget)
  const codexTarget = runtimeTarget(rateLimits.codexTarget)
  return MobileWebAccountsSnapshotSchema.parse({
    claude: accountsState(value.claude, 'claude', claudeTarget),
    codex: accountsState(value.codex, 'codex', codexTarget),
    rateLimits: {
      claude: mobileWebProviderRateLimits(rateLimits.claude, 'claude'),
      codex: mobileWebProviderRateLimits(rateLimits.codex, 'codex'),
      claudeTarget,
      codexTarget,
      inactiveClaudeAccounts: mobileWebInactiveAccountUsage(
        rateLimits.inactiveClaudeAccounts,
        'claude'
      ),
      inactiveCodexAccounts: mobileWebInactiveAccountUsage(
        rateLimits.inactiveCodexAccounts,
        'codex'
      )
    }
  })
}

export function mobileWebAccountEvent(value: unknown): MobileWebAccountEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null
  }
  if (value.type === 'end' || value.type === 'error') {
    return MobileWebAccountEventSchema.parse({ type: value.type })
  }
  if (value.type !== 'ready' && value.type !== 'snapshot') {
    return null
  }
  try {
    return MobileWebAccountEventSchema.parse({
      type: value.type,
      snapshot: mobileWebAccountsSnapshot(value.snapshot)
    })
  } catch {
    return null
  }
}

function accountsState(value: Record<string, unknown>, provider: Provider, target: RuntimeTarget) {
  const activeAccountId = boundedRequiredText(value.activeAccountId, 256)
  const activeAccountIdsByRuntime = runtimeSelection(value.activeAccountIdsByRuntime)
  const targetAccountId =
    target.runtime === 'host'
      ? activeAccountIdsByRuntime?.host
      : target.wslDistro
        ? activeAccountIdsByRuntime?.wsl[target.wslDistro]
        : null
  const source = Array.isArray(value.accounts) ? value.accounts : []
  const accounts = source.flatMap((account) => accountPresentation(account, provider))
  const bounded = boundedAccounts(accounts, [activeAccountId, targetAccountId])
  const visibleIds = new Set(bounded.map((account) => account.id))
  return {
    accounts: bounded,
    activeAccountId: activeAccountId && visibleIds.has(activeAccountId) ? activeAccountId : null,
    ...(activeAccountIdsByRuntime
      ? {
          activeAccountIdsByRuntime: visibleRuntimeSelection(activeAccountIdsByRuntime, visibleIds)
        }
      : {})
  }
}

function boundedAccounts<T extends { id: string }>(
  accounts: readonly T[],
  priorityIds: readonly (string | null | undefined)[]
): T[] {
  const bounded = accounts.slice(0, MOBILE_WEB_ACCOUNT_LIMIT)
  const priorities = new Set(priorityIds.filter((id): id is string => Boolean(id)))
  for (const id of priorities) {
    if (bounded.some((account) => account.id === id)) {
      continue
    }
    const account = accounts.find((candidate) => candidate.id === id)
    if (!account) {
      continue
    }
    const replaceIndex = bounded.findLastIndex((candidate) => !priorities.has(candidate.id))
    if (replaceIndex !== -1) {
      bounded[replaceIndex] = account
    }
  }
  return bounded
}

function accountPresentation(value: unknown, provider: Provider) {
  if (!isRecord(value)) {
    return []
  }
  const id = boundedRequiredText(value.id, 256)
  const email = boundedRequiredText(value.email, 320)
  if (!id || !email) {
    return []
  }
  if (provider === 'codex') {
    const updatedAt = boundedTimestampOrNull(value.updatedAt)
    if (updatedAt === null) {
      return []
    }
    return [
      {
        id,
        email,
        updatedAt,
        ...optionalEnumField('managedHomeRuntime', value.managedHomeRuntime, ['host', 'wsl']),
        ...optionalNullableTextField('wslDistro', value.wslDistro, 255),
        ...optionalNullableTextField('workspaceLabel', value.workspaceLabel, 240),
        ...optionalNullableTextField('workspaceAccountId', value.workspaceAccountId, 256),
        ...optionalTimestampField('createdAt', value.createdAt),
        ...optionalTimestampField('lastAuthenticatedAt', value.lastAuthenticatedAt)
      }
    ]
  }
  return [
    {
      id,
      email,
      ...optionalEnumField('managedAuthRuntime', value.managedAuthRuntime, ['host', 'wsl']),
      ...optionalNullableTextField('wslDistro', value.wslDistro, 255),
      ...optionalEnumField('authMethod', value.authMethod, ['subscription-oauth', 'unknown']),
      ...optionalNullableTextField('organizationUuid', value.organizationUuid, 256),
      ...optionalNullableTextField('organizationName', value.organizationName, 240),
      ...optionalTimestampField('createdAt', value.createdAt),
      ...optionalTimestampField('updatedAt', value.updatedAt),
      ...optionalTimestampField('lastAuthenticatedAt', value.lastAuthenticatedAt)
    }
  ]
}

function runtimeSelection(value: unknown) {
  if (!isRecord(value)) {
    return undefined
  }
  const wsl = isRecord(value.wsl)
    ? Object.fromEntries(
        Object.entries(value.wsl)
          .filter(
            ([distro]) => distro.length > 0 && distro.length <= 255 && distro.trim() === distro
          )
          .slice(0, MOBILE_WEB_ACCOUNT_LIMIT)
          .map(([distro, accountId]) => [distro, boundedRequiredText(accountId, 256)])
      )
    : {}
  return {
    host: boundedRequiredText(value.host, 256),
    wsl
  }
}

function visibleRuntimeSelection(
  selection: { host: string | null; wsl: Record<string, string | null> },
  visibleIds: ReadonlySet<string>
) {
  return {
    host: selection.host && visibleIds.has(selection.host) ? selection.host : null,
    wsl: Object.fromEntries(
      Object.entries(selection.wsl).map(([distro, accountId]) => [
        distro,
        accountId && visibleIds.has(accountId) ? accountId : null
      ])
    )
  }
}

function runtimeTarget(value: unknown): RuntimeTarget {
  if (!isRecord(value) || value.runtime !== 'wsl') {
    return HOST_TARGET
  }
  const distro = boundedRequiredText(value.wslDistro, 255)
  return distro && distro.trim() === distro ? { runtime: 'wsl', wslDistro: distro } : HOST_TARGET
}

function optionalEnumField<const T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[]
) {
  return typeof value === 'string' && allowed.includes(value as T) ? { [name]: value as T } : {}
}

function optionalNullableTextField(name: string, value: unknown, maximum: number) {
  return value === undefined ? {} : { [name]: boundedNullableText(value, maximum) }
}

function optionalTimestampField(name: string, value: unknown) {
  const timestamp = boundedTimestampOrNull(value)
  return timestamp === null ? {} : { [name]: timestamp }
}

function boundedTimestampOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedRequiredText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null
}

function boundedNullableText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' ? value.slice(0, maximum) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
