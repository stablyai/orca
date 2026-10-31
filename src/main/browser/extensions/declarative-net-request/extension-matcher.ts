import type { DnrRequestContext } from './request-context'
import {
  compareActions,
  isAllowAction,
  maxAction,
  type DnrRequestAction,
  type DnrRulesetMatcher,
  type DnrStage
} from './ruleset-matcher'

// CompositeMatcher (composite_matcher.cc): every enabled ruleset of one extension.

/** WebRequestPermissions::CanExtensionAccessURL with REQUIRE_HOST_PERMISSION_FOR_URL_AND_INITIATOR. */
export type DnrHostAccess = 'allowed' | 'withheld' | 'denied'

/** Per-ruleset allowAllRequests decisions inherited by a frame's requests and child frames. */
export type DnrFrameAllowState = ReadonlyMap<DnrRulesetMatcher, DnrRequestAction>

export type DnrExtensionActionInfo = {
  action: DnrRequestAction | null
  /** The request was withheld from this extension (it would have acted). */
  withheld: boolean
}

export class DnrExtensionMatcher {
  private readonly rulesets = new Map<string, DnrRulesetMatcher>()

  constructor(
    readonly extensionId: string,
    readonly installTime: number,
    public hostPermissionsAlwaysRequired: boolean
  ) {}

  /** Replaces (or with null removes) the ruleset stored under `key`; returns the old one. */
  setRuleset(key: string, matcher: DnrRulesetMatcher | null): DnrRulesetMatcher | undefined {
    const previous = this.rulesets.get(key)
    if (previous) {
      previous.attached = false
      this.rulesets.delete(key)
    }
    if (matcher) {
      matcher.attached = true
      this.rulesets.set(key, matcher)
    }
    return previous
  }

  ruleset(key: string): DnrRulesetMatcher | undefined {
    return this.rulesets.get(key)
  }

  /** Detaches every ruleset and returns them. */
  detachAll(): DnrRulesetMatcher[] {
    const matchers = [...this.rulesets.values()]
    for (const matcher of matchers) {
      matcher.attached = false
    }
    this.rulesets.clear()
    return matchers
  }

  hasRules(stage: DnrStage): boolean {
    return [...this.rulesets.values()].some((matcher) => matcher.hasRules(stage))
  }

  /**
   * CompositeMatcher::GetAction. `allowState` carries the extension's best allow across
   * request stages (WebRequestInfo::max_priority_allow_action) and is updated in place.
   */
  getAction(
    context: DnrRequestContext,
    stage: DnrStage,
    frameAllow: DnrFrameAllowState | undefined,
    allowState: Map<string, DnrRequestAction | null>,
    access: DnrHostAccess
  ): DnrExtensionActionInfo {
    const prior = allowState.get(this.extensionId) ?? null
    allowState.set(this.extensionId, prior)
    let finalAction = prior
    for (const matcher of this.rulesets.values()) {
      const ancestor = frameAllow?.get(matcher)
      const action = matcher.getAction(
        context,
        stage,
        ancestor && matcher.attached ? ancestor : null
      )
      const maxAllowPriority = allowState.get(this.extensionId)?.indexPriority ?? 0
      if (action === null || action.indexPriority <= maxAllowPriority) {
        continue
      }
      if (isAllowAction(action)) {
        allowState.set(this.extensionId, action)
      }
      finalAction = maxAction(finalAction, action)
    }
    if (finalAction === null) {
      return { action: null, withheld: false }
    }
    // Redirects (but not upgrades) always need host access to the URL and initiator.
    const needsHostAccess = this.hostPermissionsAlwaysRequired || finalAction.type === 'redirect'
    if (!needsHostAccess || access === 'allowed') {
      return { action: finalAction, withheld: false }
    }
    return { action: null, withheld: access === 'withheld' && !isAllowAction(finalAction) }
  }

  /** CompositeMatcher::GetModifyHeadersActions, highest priority first. */
  modifyHeadersActions(
    context: DnrRequestContext,
    stage: DnrStage,
    allowState: ReadonlyMap<string, DnrRequestAction | null>
  ): DnrRequestAction[] {
    const minPriority = allowState.get(this.extensionId)?.indexPriority ?? 0
    const actions: DnrRequestAction[] = []
    for (const matcher of this.rulesets.values()) {
      actions.push(...matcher.modifyHeadersActions(context, stage, minPriority))
    }
    return actions.sort((left, right) => compareActions(right, left))
  }

  /** OnDidFinishNavigation: each ruleset's own allowAllRequests match for the committed frame. */
  collectFrameAllow(
    context: DnrRequestContext,
    stage: DnrStage,
    into: Map<DnrRulesetMatcher, DnrRequestAction>
  ): void {
    for (const matcher of this.rulesets.values()) {
      const action = maxAction(
        into.get(matcher) ?? null,
        matcher.allowAllRequestsAction(context, stage)
      )
      if (action !== null) {
        into.set(matcher, action)
      }
    }
  }

  /** Folds in what the parent frame inherited, for rulesets that are still attached. */
  inheritFrameAllow(
    parent: DnrFrameAllowState | undefined,
    into: Map<DnrRulesetMatcher, DnrRequestAction>
  ): void {
    for (const matcher of this.rulesets.values()) {
      const inherited = parent?.get(matcher)
      const action = maxAction(
        inherited && matcher.attached ? inherited : null,
        into.get(matcher) ?? null
      )
      if (action !== null) {
        into.set(matcher, action)
      }
    }
  }
}
