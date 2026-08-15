import type { KeybindingService } from './keybindings/keybinding-service'
import type { Store } from './persistence'
import {
  createPortableSettingsSyncSnapshot,
  normalizePortableSettingsSyncCategories,
  remotePortableSettingsNeedSync,
  unwrapPortableSettingsSyncResponse
} from './portable-settings-sync-bundle'
import {
  createPortableSettingsSyncRuleCommitter,
  readPortableSettingsSyncRules,
  type PortableSettingsSyncRuleCommitter,
  type PortableSettingsSyncRuntimeState
} from './portable-settings-sync-file'
import { PortableSettingsSyncScheduler } from './portable-settings-sync-scheduler'
import { runWithSettingsSyncSuppressed } from './portable-settings-sync-suppression'
import type { PortableSettingsCategory } from '../shared/portable-settings'
import {
  PortableSettingsSyncConfigureArgsSchema,
  type PortableSettingsSyncConfigureArgs,
  type PortableSettingsSyncRule,
  type PortableSettingsSyncState
} from '../shared/portable-settings-sync'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'

type PortableSettingsSyncDependencies = {
  configPath: string
  store: Pick<Store, 'getSettings' | 'onSettingsChanged'>
  keybindings: Pick<KeybindingService, 'getSnapshot' | 'onChanged'>
  callEnvironment: (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<unknown>>
  environmentExists: (environmentId: string) => boolean
  now?: () => number
}

export class PortableSettingsSyncService {
  private readonly rules = new Map<string, PortableSettingsSyncRule>()
  private readonly runtimeStates = new Map<string, PortableSettingsSyncRuntimeState>()
  private readonly listeners = new Set<(states: PortableSettingsSyncState[]) => void>()
  private readonly scheduler: PortableSettingsSyncScheduler
  private readonly commitRule: PortableSettingsSyncRuleCommitter
  private readonly now: () => number
  private suppressOutboundDepth = 0
  private unsubscribeSettings: (() => void) | null = null
  private unsubscribeKeybindings: (() => void) | null = null

  constructor(private readonly deps: PortableSettingsSyncDependencies) {
    this.now = deps.now ?? Date.now
    this.scheduler = new PortableSettingsSyncScheduler(
      (environmentId, forceRemoteCheck) => this.performSync(environmentId, forceRemoteCheck),
      (environmentId) => this.markPending(environmentId)
    )
    this.commitRule = createPortableSettingsSyncRuleCommitter(
      deps.configPath,
      this.rules,
      this.runtimeStates,
      () => this.emit()
    )
    for (const rule of readPortableSettingsSyncRules(deps.configPath)) {
      this.rules.set(rule.environmentId, rule)
      this.runtimeStates.set(rule.environmentId, {
        phase: rule.enabled ? 'pending' : 'paused',
        lastError: null,
        retryAttempt: 0
      })
    }
  }

  start(): void {
    if (this.unsubscribeSettings || this.unsubscribeKeybindings) {
      return
    }
    this.unsubscribeSettings = this.deps.store.onSettingsChanged(() => {
      if (this.suppressOutboundDepth === 0) {
        this.scheduleEnabledRules()
      }
    })
    this.unsubscribeKeybindings = this.deps.keybindings.onChanged(() => {
      if (this.suppressOutboundDepth === 0) {
        this.scheduleEnabledRules('input')
      }
    })
    for (const rule of this.rules.values()) {
      if (rule.enabled) {
        this.schedule(rule.environmentId, 0, true)
      }
    }
  }

  dispose(): void {
    this.unsubscribeSettings?.()
    this.unsubscribeKeybindings?.()
    this.unsubscribeSettings = null
    this.unsubscribeKeybindings = null
    this.scheduler.dispose()
  }

  runWithoutOutboundSync<T>(operation: () => T): T {
    return runWithSettingsSyncSuppressed(
      operation,
      () => (this.suppressOutboundDepth += 1),
      () => (this.suppressOutboundDepth -= 1)
    )
  }

  getStates(): PortableSettingsSyncState[] {
    return Array.from(this.rules.values()).map((rule) => this.toPublicState(rule))
  }

  getState(environmentId: string): PortableSettingsSyncState | null {
    const rule = this.rules.get(environmentId)
    return rule ? this.toPublicState(rule) : null
  }

  async configure(input: PortableSettingsSyncConfigureArgs): Promise<PortableSettingsSyncState> {
    const args = PortableSettingsSyncConfigureArgsSchema.parse(input)
    if (!this.deps.environmentExists(args.environmentId)) {
      throw new Error('The remote server is no longer saved.')
    }
    const categories = normalizePortableSettingsSyncCategories(args.categories)
    const previous = this.rules.get(args.environmentId)
    if (!previous && this.rules.size >= 100) {
      throw new Error('Too many settings sync rules are configured.')
    }
    const categoriesChanged =
      !previous || JSON.stringify(previous.categories) !== JSON.stringify(categories)
    const rule: PortableSettingsSyncRule = {
      environmentId: args.environmentId,
      categories,
      enabled: args.enabled,
      lastSyncedHash: categoriesChanged ? null : previous.lastSyncedHash,
      lastSyncedAt: categoriesChanged ? null : previous.lastSyncedAt
    }
    this.commitRule(rule, {
      phase: args.enabled ? 'pending' : 'paused',
      lastError: null,
      retryAttempt: 0
    })
    if (!args.enabled) {
      this.scheduler.clear(args.environmentId)
      return this.toPublicState(rule)
    }
    return this.syncNow(args.environmentId)
  }

  pause(environmentId: string): PortableSettingsSyncState {
    const rule = this.requireRule(environmentId)
    const paused = { ...rule, enabled: false }
    this.commitRule(paused, {
      phase: 'paused',
      lastError: null,
      retryAttempt: 0
    })
    this.scheduler.clear(environmentId)
    return this.toPublicState(paused)
  }

  stop(environmentId: string): void {
    this.requireRule(environmentId)
    this.commitRule(null, null, environmentId)
    this.scheduler.clear(environmentId)
  }

  syncNow(environmentId: string): Promise<PortableSettingsSyncState> {
    this.scheduler.clear(environmentId)
    return this.scheduler.enqueue(environmentId, true)
  }

  onStateChanged(listener: (states: PortableSettingsSyncState[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private scheduleEnabledRules(requiredCategory?: PortableSettingsCategory): void {
    for (const rule of this.rules.values()) {
      if (rule.enabled && (!requiredCategory || rule.categories.includes(requiredCategory))) {
        this.schedule(rule.environmentId, 1_000, false)
      }
    }
  }

  private schedule(
    environmentId: string,
    delayMs: number,
    forceRemoteCheck: boolean,
    markPending = true
  ): void {
    if (this.rules.get(environmentId)?.enabled) {
      this.scheduler.schedule(environmentId, delayMs, forceRemoteCheck, markPending)
    }
  }

  private markPending(environmentId: string): void {
    const runtime = this.runtimeStates.get(environmentId)
    this.runtimeStates.set(environmentId, {
      phase: 'pending',
      lastError: runtime?.lastError ?? null,
      retryAttempt: runtime?.retryAttempt ?? 0
    })
    this.emit()
  }

  private async performSync(
    environmentId: string,
    forceRemoteCheck: boolean
  ): Promise<PortableSettingsSyncState> {
    const rule = this.requireRule(environmentId)
    if (!this.deps.environmentExists(environmentId)) {
      this.stop(environmentId)
      throw new Error('The synced remote server is no longer saved.')
    }
    this.setRuntimeState(environmentId, { phase: 'syncing', lastError: null })
    const { bundle, hash: bundleHash } = createPortableSettingsSyncSnapshot(
      this.deps.store.getSettings(),
      this.deps.keybindings.getSnapshot(),
      rule.categories
    )

    try {
      if (!forceRemoteCheck && bundleHash === rule.lastSyncedHash) {
        this.setRuntimeState(environmentId, {
          phase: rule.enabled ? 'synced' : 'paused',
          lastError: null,
          retryAttempt: 0
        })
        return this.toPublicState(rule)
      }

      let shouldApply = true
      if (forceRemoteCheck) {
        const remoteResponse = await this.deps.callEnvironment(
          environmentId,
          'settings.portable.get',
          undefined,
          15_000
        )
        const remoteResult = unwrapPortableSettingsSyncResponse<{ bundle: unknown }>(remoteResponse)
        shouldApply = remotePortableSettingsNeedSync(bundle, remoteResult.bundle, rule.categories)
      }

      if (shouldApply) {
        const applyResponse = await this.deps.callEnvironment(
          environmentId,
          'settings.portable.apply',
          { categories: rule.categories, bundle },
          15_000
        )
        unwrapPortableSettingsSyncResponse(applyResponse)
      }

      const latestRule = this.requireRule(environmentId)
      const syncedRule: PortableSettingsSyncRule = {
        ...latestRule,
        lastSyncedHash: bundleHash,
        lastSyncedAt: this.now()
      }
      this.commitRule(syncedRule, {
        phase: syncedRule.enabled ? 'synced' : 'paused',
        lastError: null,
        retryAttempt: 0
      })
      return this.toPublicState(syncedRule)
    } catch (error) {
      const latestRule = this.rules.get(environmentId)
      if (!latestRule) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      const previousAttempt = this.runtimeStates.get(environmentId)?.retryAttempt ?? 0
      this.runtimeStates.set(environmentId, {
        phase: 'error',
        lastError: message,
        retryAttempt: previousAttempt + 1
      })
      this.emit()
      if (latestRule.enabled) {
        this.scheduler.scheduleRetry(environmentId, previousAttempt)
      }
      throw error
    }
  }

  private setRuntimeState(
    environmentId: string,
    updates: Partial<PortableSettingsSyncRuntimeState>
  ): void {
    const current = this.runtimeStates.get(environmentId) ?? {
      phase: 'pending',
      lastError: null,
      retryAttempt: 0
    }
    this.runtimeStates.set(environmentId, { ...current, ...updates })
    this.emit()
  }

  private requireRule(environmentId: string): PortableSettingsSyncRule {
    const rule = this.rules.get(environmentId)
    if (!rule) {
      throw new Error('Settings sync is not configured for this server.')
    }
    return rule
  }

  private toPublicState(rule: PortableSettingsSyncRule): PortableSettingsSyncState {
    const runtime = this.runtimeStates.get(rule.environmentId)
    return {
      ...rule,
      phase: runtime?.phase ?? (rule.enabled ? 'pending' : 'paused'),
      lastError: runtime?.lastError ?? null
    }
  }

  private emit(): void {
    const states = this.getStates()
    for (const listener of this.listeners) {
      listener(states)
    }
  }
}
