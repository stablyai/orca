import type { DnrRequestAction } from './declarative-net-request/ruleset-matcher'

/** getMatchedRules' MatchedRuleInfo. */
export type DnrMatchedRuleInfo = {
  rule: { ruleId: number; rulesetId: string }
  tabId: number
  timeStamp: number
}

type TabRecord = { actionCount: number; rules: DnrMatchedRuleInfo[] }
type NavigationMatch = { action: DnrRequestAction; timeStamp: number; keepsRules: boolean }

export type DnrMatchedRulesPolicy = {
  /** Only extensions that can read matches (feedback or activeTab) keep them. */
  keepsRules: (extensionId: string) => boolean
  displaysActionCount: (extensionId: string) => boolean
  /** Called only while the extension displays its count. */
  actionCountChanged: (extensionId: string, tabId: number, count: number) => void
}

// kNonActiveTabRuleLifespan: matches outside any tab are kept for five minutes.
const NON_TAB_RULE_LIFESPAN_MS = 5 * 60_000
// Why a cap: a long-lived page can match without end; Chrome keeps them all.
const MAX_RULES_PER_TAB = 10_000
const NO_TAB = -1

/**
 * ActionTracker: matched rules and action counts per extension per tab. A tab's record starts
 * over when its main frame commits a new document; the navigation's own matches carry over.
 */
export class DnrMatchedRules {
  private readonly byExtension = new Map<string, Map<number, TabRecord>>()
  private readonly pendingNavigation = new Map<number, Map<number, NavigationMatch[]>>()

  constructor(private readonly policy: DnrMatchedRulesPolicy) {}

  record(action: DnrRequestAction, tabId: number, navigationRequestId: number | null): void {
    if (navigationRequestId !== null && tabId !== NO_TAB) {
      const byRequest = this.pendingNavigation.get(tabId) ?? new Map()
      const pending = byRequest.get(navigationRequestId) ?? []
      pending.push({
        action,
        timeStamp: Date.now(),
        keepsRules: this.policy.keepsRules(action.rule.extensionId)
      })
      byRequest.set(navigationRequestId, pending)
      this.pendingNavigation.set(tabId, byRequest)
      return
    }
    this.apply(action, tabId, Date.now())
  }

  private apply(
    action: DnrRequestAction,
    tabId: number,
    timeStamp: number,
    keepsRules = true
  ): void {
    const { extensionId } = action.rule
    // Why count even when hidden: turning the badge on shows what the page already matched.
    const counts = action.type !== 'allow' && action.type !== 'allowAllRequests' && tabId !== NO_TAB
    const keeps = keepsRules && this.policy.keepsRules(extensionId)
    if (!counts && !keeps) {
      return
    }
    const record = this.tabRecord(extensionId, tabId)
    if (keeps) {
      if (tabId === NO_TAB) {
        this.trimNonTabRules(record, timeStamp)
      }
      if (record.rules.length >= MAX_RULES_PER_TAB) {
        record.rules.shift()
      }
      record.rules.push({
        rule: { ruleId: action.rule.ruleId, rulesetId: action.rule.rulesetId },
        tabId,
        timeStamp
      })
    }
    if (counts) {
      record.actionCount++
      this.showCount(extensionId, tabId, record.actionCount)
    }
  }

  private showCount(extensionId: string, tabId: number, count: number): void {
    if (this.policy.displaysActionCount(extensionId)) {
      this.policy.actionCountChanged(extensionId, tabId, count)
    }
  }

  /** Every tab's count, for an extension that just turned the badge on. */
  actionCounts(extensionId: string): [tabId: number, count: number][] {
    return [...(this.byExtension.get(extensionId) ?? [])]
      .filter(([tabId, record]) => tabId !== NO_TAB && record.actionCount > 0)
      .map(([tabId, record]) => [tabId, record.actionCount])
  }

  private tabRecord(extensionId: string, tabId: number): TabRecord {
    let byTab = this.byExtension.get(extensionId)
    if (!byTab) {
      byTab = new Map()
      this.byExtension.set(extensionId, byTab)
    }
    let record = byTab.get(tabId)
    if (!record) {
      record = { actionCount: 0, rules: [] }
      byTab.set(tabId, record)
    }
    return record
  }

  private trimNonTabRules(record: TabRecord, now: number): void {
    const first = record.rules.findIndex((info) => now - info.timeStamp < NON_TAB_RULE_LIFESPAN_MS)
    record.rules.splice(0, first === -1 ? record.rules.length : first)
  }

  /** The tab's main frame committed: drop the old document's record, keep the navigation's. */
  commitNavigation(tabId: number): void {
    this.resetTab(tabId)
    const pending = this.pendingNavigation.get(tabId)
    this.pendingNavigation.delete(tabId)
    for (const matches of pending?.values() ?? []) {
      for (const { action, timeStamp, keepsRules } of matches) {
        this.apply(action, tabId, timeStamp, keepsRules)
      }
    }
  }

  /** A blocked or failed navigation leaves the current document in place. */
  finishNavigation(tabId: number, requestId: number): void {
    const byRequest = this.pendingNavigation.get(tabId)
    const pending = byRequest?.get(requestId) ?? []
    byRequest?.delete(requestId)
    if (byRequest?.size === 0) {
      this.pendingNavigation.delete(tabId)
    }
    for (const { action, timeStamp, keepsRules } of pending) {
      this.apply(action, tabId, timeStamp, keepsRules)
    }
  }

  /** Loading ended without a commit, including a 204 response or a download. */
  finishNavigations(tabId: number): void {
    for (const requestId of this.pendingNavigation.get(tabId)?.keys() ?? []) {
      this.finishNavigation(tabId, requestId)
    }
  }

  private resetTab(tabId: number): void {
    for (const byTab of this.byExtension.values()) {
      byTab.delete(tabId)
    }
  }

  forgetTab(tabId: number): void {
    this.resetTab(tabId)
    this.pendingNavigation.delete(tabId)
  }

  forgetMatches(extensionId: string): void {
    for (const byRequest of this.pendingNavigation.values()) {
      for (const matches of byRequest.values()) {
        for (const match of matches) {
          if (match.action.rule.extensionId === extensionId) {
            match.keepsRules = false
          }
        }
      }
    }
    for (const record of this.byExtension.get(extensionId)?.values() ?? []) {
      record.rules = []
    }
  }

  forgetExtension(extensionId: string): void {
    this.byExtension.delete(extensionId)
    for (const [tabId, byRequest] of this.pendingNavigation) {
      for (const [requestId, matches] of byRequest) {
        const retained = matches.filter(({ action }) => action.rule.extensionId !== extensionId)
        if (retained.length > 0) {
          byRequest.set(requestId, retained)
        } else {
          byRequest.delete(requestId)
        }
      }
      if (byRequest.size === 0) {
        this.pendingNavigation.delete(tabId)
      }
    }
  }

  matchedRules(
    extensionId: string,
    filter: { tabId?: number; minTimeStamp?: number }
  ): DnrMatchedRuleInfo[] {
    const byTab = this.byExtension.get(extensionId)
    if (!byTab) {
      return []
    }
    const noTab = byTab.get(NO_TAB)
    if (noTab) {
      this.trimNonTabRules(noTab, Date.now())
    }
    const records =
      filter.tabId === undefined
        ? [...byTab.values()]
        : [byTab.get(filter.tabId)].filter((record) => record !== undefined)
    const minTimeStamp = filter.minTimeStamp ?? -Infinity
    return records.flatMap((record) =>
      record.rules.filter((info) => info.timeStamp >= minTimeStamp)
    )
  }

  actionCount(extensionId: string, tabId: number): number {
    return this.byExtension.get(extensionId)?.get(tabId)?.actionCount ?? 0
  }

  /** setExtensionActionOptions tabUpdate: the count never drops below zero. */
  incrementActionCount(extensionId: string, tabId: number, increment: number): void {
    const record = this.tabRecord(extensionId, tabId)
    record.actionCount = Math.max(0, record.actionCount + increment)
    this.showCount(extensionId, tabId, record.actionCount)
  }
}
