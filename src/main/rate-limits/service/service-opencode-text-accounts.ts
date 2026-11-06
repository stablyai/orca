import type { OpenCodeCredentialBackend } from '../../opencode/opencode-credential-backend'
import { environmentForStructuredOpenCodeAccountHome } from '../../opencode/opencode-structured-account-home'
import { createHash } from 'node:crypto'
import { getManagedDataAccountService } from '../../managed-data-accounts/service'
import { resolveOpenCodeGoApiKey } from '../opencode-go-api-key-source'
import { fetchOpenCodeGoUsageWithApiKey } from '../opencode-go-usage-api'
import type { OpenCodeGoUsageWindows } from '../opencode-go-status-parsing'
import { CallerJoinedSharedTasks } from '../../lib/caller-joined-shared-task'
import { RateLimitServiceInactiveAccounts } from './service-inactive-accounts'
import { DEFAULT_POLL_MS } from './service-types'

export type OpenCodeTextAccountUsage = {
  accountId: string
  credentialRevision: string
  observedAt: number
  windows: OpenCodeGoUsageWindows
}

const CREDENTIAL_LOCATION_ENV = /^(?:XDG_\w+|OPENCODE_\w+|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i

/** Callers resolving credentials from different homes/cwds must not join one refresh; hashed to keep secrets out. */
function openCodeTextRefreshKey(
  backend: OpenCodeCredentialBackend,
  environment: NodeJS.ProcessEnv,
  cwd: string
): string {
  const relevant = Object.entries(environment)
    .filter(([name, value]) => value !== undefined && CREDENTIAL_LOCATION_ENV.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify([backend, cwd, relevant]))
    .digest('hex')
}

export abstract class RateLimitServiceOpenCodeTextAccounts extends RateLimitServiceInactiveAccounts {
  private readonly openCodeTextUsage = new Map<string, OpenCodeTextAccountUsage>()
  private readonly openCodeTextRefreshes = new CallerJoinedSharedTasks<string>()
  private readonly openCodeTextRetryAt = new Map<string, number>()

  getOpenCodeTextAccountUsage(id: string, backend: OpenCodeCredentialBackend) {
    return this.openCodeTextUsage.get(`${backend}:${id}`)
  }

  /** Resolves false without fetching when every needed entry stays fresh through `freshUntil`. */
  async refreshOpenCodeTextAccounts(options: {
    signal: AbortSignal
    backend: OpenCodeCredentialBackend
    environment: NodeJS.ProcessEnv
    cwd: string
    accountIds: readonly string[]
    freshUntil: number
  }): Promise<boolean> {
    const { signal, backend } = options
    const refreshKey = openCodeTextRefreshKey(backend, options.environment, options.cwd)
    if (
      !this.openCodeTextRefreshes.has(refreshKey) &&
      options.accountIds.every((id) => {
        const observedAt = this.openCodeTextUsage.get(`${backend}:${id}`)?.observedAt
        return observedAt !== undefined && observedAt + DEFAULT_POLL_MS > options.freshUntil
      })
    ) {
      return false
    }
    await this.openCodeTextRefreshes.join(refreshKey, signal, (shared) =>
      this.runOpenCodeTextRefresh(options, shared)
    )
    return true
  }

  private async runOpenCodeTextRefresh(
    options: { backend: OpenCodeCredentialBackend; environment: NodeJS.ProcessEnv; cwd: string },
    signal: AbortSignal
  ): Promise<void> {
    const { backend } = options
    const service = getManagedDataAccountService()
    const state = service.list('opencode')
    const ids = new Set(state.accounts.map((a) => a.id))
    for (const key of new Set([
      ...this.openCodeTextUsage.keys(),
      ...this.openCodeTextRetryAt.keys()
    ])) {
      const id = key.slice(key.indexOf(':') + 1)
      if (!ids.has(id)) {
        this.openCodeTextUsage.delete(key)
        this.openCodeTextRetryAt.delete(key)
      }
    }
    const controller = this.beginFetchCycle()
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      for (const account of state.accounts) {
        const key = `${backend}:${account.id}`
        if (combined.aborted) {
          break
        }
        if ((this.openCodeTextRetryAt.get(key) ?? 0) > Date.now()) {
          continue
        }
        try {
          const environment = environmentForStructuredOpenCodeAccountHome(
            { kind: 'opencode', locator: { kind: 'managed', managedProfileId: account.id } },
            { managedAccounts: service, baseEnvironment: options.environment }
          )
          const before = await resolveOpenCodeGoApiKey({ environment, backend, cwd: options.cwd })
          if (
            before.status !== 'found' ||
            !['opencode-auth-file', 'opencode-credential-database'].includes(before.tier)
          ) {
            continue
          }
          let complete = false
          const result = await fetchOpenCodeGoUsageWithApiKey(before.key, combined, (value) => {
            complete = value
          })
          if (result.kind === 'failed' && result.retryAtMs) {
            this.openCodeTextRetryAt.set(key, result.retryAtMs)
          }
          const after = await resolveOpenCodeGoApiKey({ environment, backend, cwd: options.cwd })
          if (combined.aborted) {
            break
          }
          if (
            !complete ||
            result.kind !== 'ok' ||
            after.status !== 'found' ||
            before.key !== after.key
          ) {
            this.openCodeTextUsage.delete(key)
            continue
          }
          this.openCodeTextUsage.set(key, {
            accountId: account.id,
            credentialRevision: createHash('sha256').update(before.key).digest('hex'),
            observedAt: Date.now(),
            windows: result.windows
          })
        } catch {
          if (combined.aborted) {
            break
          }
          this.openCodeTextUsage.delete(key)
        }
      }
    } finally {
      this.finishFetchCycle(controller)
    }
  }
}
