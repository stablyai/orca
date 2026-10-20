import type { DnrEngine } from './declarative-net-request/engine'
import { readDnrRuleJson } from './declarative-net-request/rule-schema'
import type { DnrRule, DnrRulesetSource } from './declarative-net-request/rule-types'
import {
  DNR_API_CONSTANTS,
  DNR_ERRORS,
  DNR_MAX_DISABLED_STATIC_RULES,
  dnrRuleLimitError,
  type DnrRuleScope
} from './browser-extension-dnr-limits'
import {
  acquireDnrStaticRuleset,
  buildDnrRules,
  readDnrManifestRulesets,
  releaseDnrStaticRuleset,
  type DnrBuiltRuleset,
  type DnrManifestRuleset
} from './browser-extension-dnr-static-rulesets'
import {
  readBrowserExtensionDnrState,
  updateBrowserExtensionDnrState
} from './browser-extension-dnr-store'

/** What one extension's rules need from the session they run in. */
export type DnrExtensionRulesHost = {
  engine: DnrEngine
  profileId: string
  /** Most static rules this extension may enable: its guarantee plus the profile pool left. */
  staticRuleLimit: (extensionId: string) => number
  /** Rules changed: refresh request-path flags and caches. */
  changed: () => void
}

export class DnrApiError extends Error {}

type ScopedRules = { rules: DnrRule[]; built: DnrBuiltRuleset | null }

export type DnrAttachedRuleset = {
  source: DnrRulesetSource
  built: DnrBuiltRuleset
  disabledRuleIds: number[]
}

/** One extension's static, dynamic and session rulesets in one session (RulesMonitorService). */
export class DnrExtensionRules {
  readonly manifestRulesets: DnrManifestRuleset[]
  private readonly enabledStatic = new Map<string, DnrBuiltRuleset>()
  private disabledRuleIds: Record<string, number[]> = {}
  private readonly scoped: Record<DnrRuleScope, ScopedRules> = {
    dynamic: { rules: [], built: null },
    session: { rules: [], built: null }
  }
  private queue: Promise<unknown> = Promise.resolve()
  private unloaded = false
  displayActionCountAsBadgeText = false

  constructor(
    private readonly host: DnrExtensionRulesHost,
    readonly extension: Electron.Extension,
    installTime: number,
    hostPermissionsAlwaysRequired: boolean
  ) {
    this.manifestRulesets = readDnrManifestRulesets(extension.manifest)
    host.engine.setExtension(extension.id, { installTime, hostPermissionsAlwaysRequired })
  }

  /** Runs API updates one at a time, after the initial load, as Chrome sequences them. */
  enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  load(): Promise<void> {
    return this.enqueue(async () => {
      const state = readBrowserExtensionDnrState(this.host.profileId, this.extension)
      this.disabledRuleIds = state.disabledRuleIds
      this.displayActionCountAsBadgeText = state.displayActionCountAsBadgeText
      const wanted = state.enabledRulesetIds
        ? this.manifestRulesets.filter((ruleset) => state.enabledRulesetIds?.includes(ruleset.id))
        : this.manifestRulesets.filter((ruleset) => ruleset.enabled)
      await this.enableStaticWithinLimits(wanted)
      const dynamic = state.dynamicRules.flatMap((json) => {
        const read = readDnrRuleJson(json)
        return read.ok ? [read.rule] : []
      })
      if (dynamic.length > 0 && !this.unloaded) {
        const result = await buildDnrRules(dynamic, this.extension.id, { kind: 'dynamic' }, 'warn')
        if (result.ok && !this.unloaded) {
          this.setScoped('dynamic', dynamic, result.built)
          this.host.changed()
        }
      }
    })
  }

  /** Extension unloaded: its rules leave the engine; session rules are gone for good. */
  unload(): void {
    this.unloaded = true
    for (const id of this.enabledStatic.keys()) {
      releaseDnrStaticRuleset(this.extension, id)
    }
    this.enabledStatic.clear()
    this.host.engine.removeExtension(this.extension.id)
    this.host.changed()
  }

  // Load time skips what does not fit, as Chrome ignores rulesets past the limits.
  private async enableStaticWithinLimits(wanted: DnrManifestRuleset[]): Promise<void> {
    let rules = 0
    let regexRules = 0
    for (const ruleset of wanted.slice(
      0,
      DNR_API_CONSTANTS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS
    )) {
      const built = await acquireDnrStaticRuleset(this.extension, ruleset)
      if (this.unloaded) {
        releaseDnrStaticRuleset(this.extension, ruleset.id)
        return
      }
      const fits =
        built !== null &&
        rules + built.ruleCount <= this.host.staticRuleLimit(this.extension.id) &&
        regexRules + built.regexRuleCount <= DNR_API_CONSTANTS.MAX_NUMBER_OF_REGEX_RULES
      if (!fits) {
        releaseDnrStaticRuleset(this.extension, ruleset.id)
        continue
      }
      rules += built.ruleCount
      regexRules += built.regexRuleCount
      this.attachStatic(ruleset, built)
    }
    this.host.changed()
  }

  private attachStatic(ruleset: DnrManifestRuleset, built: DnrBuiltRuleset): void {
    this.enabledStatic.set(ruleset.id, built)
    this.host.engine.setRuleset(this.extension.id, ruleset.source, built.index)
    this.host.engine.setDisabledStaticRuleIds(
      this.extension.id,
      ruleset.id,
      this.disabledRuleIds[ruleset.id] ?? []
    )
  }

  private requireRuleset(id: string): DnrManifestRuleset {
    const ruleset = this.manifestRulesets.find((candidate) => candidate.id === id)
    if (!ruleset) {
      throw new DnrApiError(DNR_ERRORS.invalidRulesetId(id))
    }
    return ruleset
  }

  enabledRulesetIds(): string[] {
    return this.manifestRulesets.filter((r) => this.enabledStatic.has(r.id)).map((r) => r.id)
  }

  staticRuleCount(): number {
    return [...this.enabledStatic.values()].reduce((sum, built) => sum + built.ruleCount, 0)
  }

  usesResponseStage(): boolean {
    return [
      ...this.enabledStatic.values(),
      this.scoped.dynamic.built,
      this.scoped.session.built
    ].some((built) => built?.usesResponseStage === true)
  }

  /** Every attached ruleset, for testMatchOutcome's extension-only engine. */
  attachedRulesets(): DnrAttachedRuleset[] {
    const attached = this.manifestRulesets.flatMap((ruleset): DnrAttachedRuleset[] => {
      const built = this.enabledStatic.get(ruleset.id)
      return built
        ? [
            {
              source: ruleset.source,
              built,
              disabledRuleIds: this.disabledRuleIds[ruleset.id] ?? []
            }
          ]
        : []
    })
    for (const scope of ['dynamic', 'session'] as const) {
      const built = this.scoped[scope].built
      if (built) {
        attached.push({ source: { kind: scope }, built, disabledRuleIds: [] })
      }
    }
    return attached
  }

  updateEnabledRulesets(enableIds: string[], disableIds: string[]): Promise<void> {
    return this.enqueue(async () => {
      const enable = new Set(enableIds.map((id) => this.requireRuleset(id).id))
      // Why: an id in both lists stays enabled (updateEnabledRulesets gives enable priority).
      const disable = new Set(disableIds.map((id) => this.requireRuleset(id).id))
      const next = this.manifestRulesets.filter(
        (ruleset) =>
          enable.has(ruleset.id) || (this.enabledStatic.has(ruleset.id) && !disable.has(ruleset.id))
      )
      if (next.length > DNR_API_CONSTANTS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
        throw new DnrApiError(DNR_ERRORS.enabledRulesetCount)
      }
      const added = next.filter((ruleset) => !this.enabledStatic.has(ruleset.id))
      const builds = await Promise.all(
        added.map((ruleset) => acquireDnrStaticRuleset(this.extension, ruleset))
      )
      const built = next.flatMap((ruleset) => {
        const found = this.enabledStatic.get(ruleset.id) ?? builds[added.indexOf(ruleset)]
        return found ? [found] : []
      })
      const error = builds.includes(null) ? DNR_ERRORS.internal : this.staticLimitError(built)
      if (error || this.unloaded) {
        added.forEach((ruleset) => releaseDnrStaticRuleset(this.extension, ruleset.id))
        if (error) {
          throw new DnrApiError(error)
        }
        return
      }
      for (const ruleset of this.manifestRulesets) {
        if (this.enabledStatic.has(ruleset.id) && !next.includes(ruleset)) {
          this.enabledStatic.delete(ruleset.id)
          this.host.engine.setRuleset(this.extension.id, ruleset.source, null)
          releaseDnrStaticRuleset(this.extension, ruleset.id)
        }
      }
      added.forEach((ruleset, index) => {
        const built = builds[index]
        if (built) {
          this.attachStatic(ruleset, built)
        }
      })
      updateBrowserExtensionDnrState(this.host.profileId, this.extension, {
        enabledRulesetIds: next.map((ruleset) => ruleset.id)
      })
      this.host.changed()
    })
  }

  private staticLimitError(built: readonly DnrBuiltRuleset[]): string | null {
    if (
      built.reduce((sum, ruleset) => sum + ruleset.ruleCount, 0) >
      this.host.staticRuleLimit(this.extension.id)
    ) {
      return DNR_ERRORS.enabledRulesetsRuleCount
    }
    return built.reduce((sum, ruleset) => sum + ruleset.regexRuleCount, 0) >
      DNR_API_CONSTANTS.MAX_NUMBER_OF_REGEX_RULES
      ? DNR_ERRORS.enabledRulesetsRegexRuleCount
      : null
  }

  disabledRuleIdsFor(rulesetId: string): number[] {
    return [...(this.disabledRuleIds[this.requireRuleset(rulesetId).id] ?? [])]
  }

  updateStaticRules(rulesetId: string, disableIds: number[], enableIds: number[]): Promise<void> {
    return this.enqueue(() => {
      const ruleset = this.requireRuleset(rulesetId)
      const enable = new Set(enableIds)
      const ids = new Set([...(this.disabledRuleIds[ruleset.id] ?? []), ...disableIds])
      const nextIds = [...ids].filter((id) => !enable.has(id)).sort((a, b) => a - b)
      const next = { ...this.disabledRuleIds, [ruleset.id]: nextIds }
      if (nextIds.length === 0) {
        delete next[ruleset.id]
      }
      const total = Object.values(next).reduce((sum, list) => sum + list.length, 0)
      if (total > DNR_MAX_DISABLED_STATIC_RULES) {
        throw new DnrApiError(DNR_ERRORS.disabledStaticRuleCount)
      }
      this.disabledRuleIds = next
      this.host.engine.setDisabledStaticRuleIds(this.extension.id, ruleset.id, nextIds)
      updateBrowserExtensionDnrState(this.host.profileId, this.extension, {
        disabledRuleIds: next
      })
      this.host.changed()
    })
  }

  getRules(scope: DnrRuleScope, ruleIds?: number[]): DnrRule[] {
    const wanted = ruleIds ? new Set(ruleIds) : null
    return this.scoped[scope].rules.filter((rule) => !wanted || wanted.has(rule.id))
  }

  /** updateDynamicRules / updateSessionRules: removals first, then additions, all or nothing. */
  updateRules(scope: DnrRuleScope, removeIds: number[], addRules: unknown[]): Promise<void> {
    return this.enqueue(async () => {
      const remove = new Set(removeIds)
      const kept = this.scoped[scope].rules.filter((rule) => !remove.has(rule.id))
      const candidates = [...kept, ...addRules]
      const added: DnrRule[] = []
      for (const json of addRules) {
        const read = readDnrRuleJson(json)
        if (read.ok) {
          added.push(read.rule)
        }
      }
      const result = await buildDnrRules(candidates, this.extension.id, { kind: scope }, 'error')
      if (!result.ok) {
        throw new DnrApiError(result.error)
      }
      const rules = [...kept, ...added]
      const limitError = dnrRuleLimitError(scope, rules, result.built.regexRuleCount)
      if (limitError) {
        throw new DnrApiError(limitError)
      }
      if (this.unloaded) {
        return
      }
      this.setScoped(scope, rules, result.built)
      if (scope === 'dynamic') {
        updateBrowserExtensionDnrState(this.host.profileId, this.extension, {
          dynamicRules: rules
        })
      }
      this.host.changed()
    })
  }

  private setScoped(scope: DnrRuleScope, rules: DnrRule[], built: DnrBuiltRuleset | null): void {
    const attached = rules.length > 0 ? built : null
    this.scoped[scope] = { rules, built: attached }
    this.host.engine.setRuleset(this.extension.id, { kind: scope }, attached?.index ?? null)
  }

  setDisplayActionCountAsBadgeText(display: boolean): void {
    this.displayActionCountAsBadgeText = display
    updateBrowserExtensionDnrState(this.host.profileId, this.extension, {
      displayActionCountAsBadgeText: display
    })
  }
}
