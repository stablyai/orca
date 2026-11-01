import type { DnrHeaderModification } from './header-rules'
import type { DnrIndexedRule } from './indexed-rule'
import { transformDnrUrl, upgradeDnrUrl } from './redirect-url'
import { applyRegexSubstitution } from './regex-filter'
import { isCollapsibleType, type DnrRequestContext } from './request-context'
import { ELEMENT_TYPE } from './rule-flags'
import { regexRuleMetadataMatches, urlRuleMatches } from './rule-matching'
import { compareRulePriority, type DnrRulePartition, type DnrRulesetIndex } from './ruleset-index'
import type { DnrRulesetSource } from './rule-types'
import { dnrPublicRulesetId, dnrRulesetOrdinal } from './rule-types'

// One ruleset's matcher: ruleset_matcher.cc, extension_url_pattern_index_matcher.cc,
// regex_rules_matcher.cc and ruleset_matcher_base.cc.

export type DnrStage = 'beforeRequest' | 'headersReceived'

/** What a request action does; `collapse` is a block that also hides the element. */
export type DnrRequestActionType =
  | 'block'
  | 'collapse'
  | 'allow'
  | 'allowAllRequests'
  | 'redirect'
  | 'upgradeScheme'
  | 'modifyHeaders'

export type DnrMatchedRule = { extensionId: string; rulesetId: string; ruleId: number }

export type DnrRequestAction = {
  type: DnrRequestActionType
  rule: DnrMatchedRule
  /** Rule priority with the action-type tie-break folded in. */
  indexPriority: number
  /** Chromium RulesetID: session -1, dynamic 0, static 1..n. */
  rulesetOrdinal: number
  redirectUrl?: string
  requestHeaders?: DnrHeaderModification[]
  responseHeaders?: DnrHeaderModification[]
}

/** RequestAction operator<: (index priority, ruleset id, rule id). */
export function compareActions(left: DnrRequestAction, right: DnrRequestAction): number {
  return (
    left.indexPriority - right.indexPriority ||
    left.rulesetOrdinal - right.rulesetOrdinal ||
    left.rule.ruleId - right.rule.ruleId
  )
}

export function maxAction(
  left: DnrRequestAction | null,
  right: DnrRequestAction | null
): DnrRequestAction | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return compareActions(left, right) > 0 ? left : right
}

export function isAllowAction(action: DnrRequestAction | null): boolean {
  return action?.type === 'allow' || action?.type === 'allowAllRequests'
}

/** Per-request regex work shared by the action, allow-all and modifyHeaders queries. */
type RegexCache = Map<DnrRulePartition, DnrIndexedRule[]>
const regexCaches = new WeakMap<DnrRequestContext, RegexCache>()

export class DnrRulesetMatcher {
  readonly ordinal: number
  readonly publicId: string
  /** Cleared when the extension drops this ruleset; frames then stop inheriting its allows. */
  attached = true
  /** updateStaticRules ids. Like Chromium, these never disable regex rules. */
  disabledRuleIds: ReadonlySet<number> = new Set()

  constructor(
    readonly extensionId: string,
    readonly source: DnrRulesetSource,
    readonly index: DnrRulesetIndex
  ) {
    this.ordinal = dnrRulesetOrdinal(source)
    this.publicId = dnrPublicRulesetId(source)
  }

  private action(
    rule: DnrIndexedRule,
    type: DnrRequestActionType,
    extra: Partial<DnrRequestAction> = {}
  ): DnrRequestAction {
    return {
      type,
      rule: { extensionId: this.extensionId, rulesetId: this.publicId, ruleId: rule.id },
      indexPriority: rule.indexPriority,
      rulesetOrdinal: this.ordinal,
      ...extra
    }
  }

  /** CreateRedirectAction: websocket handshakes and self-redirects produce no action. */
  private redirectAction(
    rule: DnrIndexedRule,
    context: DnrRequestContext,
    url: string | null
  ): DnrRequestAction | null {
    if (
      context.elementType === ELEMENT_TYPE.websocket ||
      url === null ||
      url === context.url.spec
    ) {
      return null
    }
    return this.action(rule, 'redirect', { redirectUrl: url })
  }

  /** CreateActionFromInfo / GetActionHelper; null may mask lower-priority rules. */
  private createAction(rule: DnrIndexedRule, context: DnrRequestContext): DnrRequestAction | null {
    switch (rule.action) {
      case 'block':
        return this.action(rule, isCollapsibleType(context) ? 'collapse' : 'block')
      case 'allow':
      case 'allowAllRequests':
        return this.action(rule, rule.action)
      case 'upgradeScheme': {
        const url = upgradeDnrUrl(context.url.spec)
        return url === null ? null : this.action(rule, 'upgradeScheme', { redirectUrl: url })
      }
      case 'redirect': {
        const redirect = rule.redirect
        if (redirect === null) {
          return null
        }
        if (redirect.kind === 'url') {
          return this.redirectAction(rule, context, redirect.url)
        }
        if (redirect.kind === 'transform') {
          return this.redirectAction(
            rule,
            context,
            transformDnrUrl(context.url.spec, redirect.transform)
          )
        }
        const regex = rule.regex?.regex
        const rewritten = regex
          ? applyRegexSubstitution(regex, context.url.spec, redirect.substitution)
          : null
        return this.redirectAction(rule, context, canonicalRedirect(rewritten))
      }
      case 'modifyHeaders':
        return null
    }
  }

  /** kHighestPriority search over one url-filter partition. */
  private bestUrlRule(
    partition: DnrRulePartition,
    context: DnrRequestContext
  ): DnrIndexedRule | null {
    let best: DnrIndexedRule | null = null
    for (const rules of partition.candidateLists(context)) {
      for (const rule of rules) {
        if (best !== null && compareRulePriority(rule, best) >= 0) {
          break
        }
        if (urlRuleMatches(rule, context, this.disabledRuleIds)) {
          best = rule
          break
        }
      }
    }
    return best
  }

  /** GetPotentialMatches: metadata-matching regex rules, highest priority first. */
  private regexCandidates(
    partition: DnrRulePartition,
    context: DnrRequestContext
  ): DnrIndexedRule[] {
    if (partition.size === 0) {
      return []
    }
    let cache = regexCaches.get(context)
    if (!cache) {
      cache = new Map()
      regexCaches.set(context, cache)
    }
    const cached = cache.get(partition)
    if (cached) {
      return cached
    }
    const candidates: DnrIndexedRule[] = []
    for (const rules of partition.candidateLists(context)) {
      for (const rule of rules) {
        if (regexRuleMetadataMatches(rule, context)) {
          candidates.push(rule)
        }
      }
    }
    candidates.sort(compareRulePriority)
    cache.set(partition, candidates)
    return candidates
  }

  private regexMatches(rule: DnrIndexedRule, context: DnrRequestContext): boolean {
    return rule.regex?.regex.test(context.url.spec) === true
  }

  /** GetAllowAllRequestsAction: the frame-level allow for this ruleset. */
  allowAllRequestsAction(context: DnrRequestContext, stage: DnrStage): DnrRequestAction | null {
    const partitions = this.index.stage(stage)
    const urlRule = this.bestUrlRule(partitions.allowAllRequests, context)
    const regexRule = this.regexCandidates(partitions.regex, context).find(
      (rule) => rule.action === 'allowAllRequests' && this.regexMatches(rule, context)
    )
    return maxAction(
      urlRule && this.action(urlRule, 'allowAllRequests'),
      regexRule ? this.action(regexRule, 'allowAllRequests') : null
    )
  }

  /** RulesetMatcher::GetAction, including the allow inherited from ancestor frames. */
  getAction(
    context: DnrRequestContext,
    stage: DnrStage,
    ancestorAllow: DnrRequestAction | null
  ): DnrRequestAction | null {
    const partitions = this.index.stage(stage)
    const mainRule = this.bestUrlRule(partitions.main, context)
    const urlAllowAll = this.bestUrlRule(partitions.allowAllRequests, context)
    const urlAction = maxAction(
      mainRule && this.createAction(mainRule, context),
      urlAllowAll && this.action(urlAllowAll, 'allowAllRequests')
    )
    const regexRule = this.regexCandidates(partitions.regex, context).find(
      (rule) => rule.action !== 'modifyHeaders' && this.regexMatches(rule, context)
    )
    const regexAction = regexRule ? this.createAction(regexRule, context) : null
    return maxAction(maxAction(urlAction, regexAction), ancestorAllow)
  }

  /** GetModifyHeadersActions: every modifyHeaders match above the extension's best allow. */
  modifyHeadersActions(
    context: DnrRequestContext,
    stage: DnrStage,
    minPriority: number
  ): DnrRequestAction[] {
    const partitions = this.index.stage(stage)
    const matched: DnrIndexedRule[] = []
    for (const rules of partitions.modifyHeaders.candidateLists(context)) {
      for (const rule of rules) {
        if (rule.indexPriority <= minPriority) {
          break
        }
        if (urlRuleMatches(rule, context, this.disabledRuleIds)) {
          matched.push(rule)
        }
      }
    }
    for (const rule of this.regexCandidates(partitions.regex, context)) {
      if (
        rule.action === 'modifyHeaders' &&
        rule.indexPriority > minPriority &&
        this.regexMatches(rule, context)
      ) {
        matched.push(rule)
      }
    }
    return matched.map((rule) =>
      this.action(rule, 'modifyHeaders', {
        requestHeaders: rule.requestHeaders,
        responseHeaders: rule.responseHeadersToModify
      })
    )
  }

  hasRules(stage: DnrStage): boolean {
    return Object.values(this.index.stage(stage)).some((partition) => partition.size > 0)
  }
}

/** GURL(redirect_str): invalid or javascript: results produce no redirect. */
function canonicalRedirect(url: string | null): string | null {
  if (url === null) {
    return null
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'javascript:' ? null : parsed.href
  } catch {
    return null
  }
}
