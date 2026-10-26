import {
  DnrExtensionMatcher,
  type DnrFrameAllowState,
  type DnrHostAccess
} from './extension-matcher'
import { sameDomainOrHost } from './domain-matching'
import {
  createDnrRequestContext,
  dnrOriginHost,
  type DnrRequestContext,
  type DnrRequestInfo,
  type DnrResponseHeaders
} from './request-context'
import { DnrCandidatePostings } from './candidate-postings'
import type { DnrRulesetIndex } from './ruleset-index'
import {
  createDnrRequestState,
  crossExtensionRank,
  emptyDnrEvaluation,
  mergeHeadersReceived,
  type DnrEvaluation,
  type DnrRequestState
} from './request-state'
import {
  isAllowAction,
  DnrRulesetMatcher,
  type DnrRequestAction,
  type DnrStage
} from './ruleset-matcher'
import type { DnrRulesetSource } from './rule-types'

// RulesetManager (ruleset_manager.cc) plus the per-request bookkeeping WebRequestInfo keeps
// between stages (see request-state.ts).

export { createDnrRequestState, type DnrEvaluation, type DnrRequestState }

export type DnrExtensionOptions = {
  /** Install or last-update time; later installs win ties between extensions. */
  installTime: number
  /** declarativeNetRequestWithHostAccess: every action needs host access. */
  hostPermissionsAlwaysRequired?: boolean
}

export type DnrEvaluateOptions = {
  /** allowAllRequests state of the frame issuing the request (the parent for sub_frame loads). */
  frameAllow?: DnrFrameAllowState
  hostAccess?: (extensionId: string) => DnrHostAccess
}

export type DnrFrameCommit = {
  /** The committed document URL. */
  url: string
  isPost: boolean
  /** Origin of the parent frame; null for a main frame. */
  parentOrigin: string | null
  /** The committed document's origin when it differs from the URL's (srcdoc, about:blank). */
  committedOrigin?: string | null
  topFrameOrigin?: string | null
  tabId: number
  parentState?: DnrFrameAllowState
  responseHeaders?: DnrResponseHeaders | null
}

export class DnrEngine {
  private readonly extensions = new Map<string, DnrExtensionMatcher>()
  private ordered: DnrExtensionMatcher[] = []
  private readonly postings = new DnrCandidatePostings()

  setExtension(extensionId: string, options: DnrExtensionOptions): void {
    for (const matcher of this.extensions.get(extensionId)?.detachAll() ?? []) {
      this.postings.remove(matcher.index)
    }
    this.extensions.set(
      extensionId,
      new DnrExtensionMatcher(
        extensionId,
        options.installTime,
        options.hostPermissionsAlwaysRequired === true
      )
    )
    this.reorder()
  }

  setHostPermissionsAlwaysRequired(extensionId: string, required: boolean): void {
    const matcher = this.extensions.get(extensionId)
    if (matcher) {
      matcher.hostPermissionsAlwaysRequired = required
    }
  }

  removeExtension(extensionId: string): void {
    for (const matcher of this.extensions.get(extensionId)?.detachAll() ?? []) {
      this.postings.remove(matcher.index)
    }
    this.extensions.delete(extensionId)
    this.reorder()
  }

  /** Installs, replaces or (with null) removes one ruleset of an extension. */
  setRuleset(extensionId: string, source: DnrRulesetSource, index: DnrRulesetIndex | null): void {
    const extension = this.extensions.get(extensionId)
    if (!extension) {
      throw new Error(`DNR: unknown extension ${extensionId}`)
    }
    const key = source.kind === 'static' ? `static:${source.id}` : source.kind
    const disabled = extension.ruleset(key)?.disabledRuleIds
    const matcher = index === null ? null : new DnrRulesetMatcher(extensionId, source, index)
    if (matcher && disabled) {
      matcher.disabledRuleIds = disabled
    }
    const previous = extension.setRuleset(key, matcher)
    if (previous) {
      this.postings.remove(previous.index)
    }
    if (matcher) {
      this.postings.add(matcher.index)
    }
  }

  setDisabledStaticRuleIds(
    extensionId: string,
    rulesetId: string,
    ruleIds: Iterable<number>
  ): void {
    const matcher = this.extensions.get(extensionId)?.ruleset(`static:${rulesetId}`)
    if (matcher) {
      matcher.disabledRuleIds = new Set(ruleIds)
    }
  }

  hasRules(stage: DnrStage): boolean {
    return this.ordered.some((extension) => extension.hasRules(stage))
  }

  evaluateBeforeRequest(
    request: DnrRequestInfo,
    state: DnrRequestState,
    options: DnrEvaluateOptions = {}
  ): DnrEvaluation {
    const context = this.context(request, null)
    const evaluation = context
      ? this.evaluate(request, context, 'beforeRequest', state, options)
      : emptyDnrEvaluation()
    state.actions = evaluation.actions
    return evaluation
  }

  /** EvaluateRequestWithHeaders plus the event router's merge with earlier-stage actions. */
  evaluateHeadersReceived(
    request: DnrRequestInfo,
    responseHeaders: DnrResponseHeaders,
    state: DnrRequestState,
    options: DnrEvaluateOptions = {}
  ): DnrEvaluation {
    const context = this.hasRules('headersReceived') ? this.context(request, responseHeaders) : null
    const evaluation = context
      ? this.evaluate(request, context, 'headersReceived', state, options)
      : emptyDnrEvaluation()
    return mergeHeadersReceived(
      state,
      evaluation,
      this.ordered.map((extension) => extension.extensionId)
    )
  }

  /** OnDidFinishNavigation: the allowAllRequests state every request of this frame inherits. */
  evaluateFrameCommit(commit: DnrFrameCommit): DnrFrameAllowState {
    const request: DnrRequestInfo = {
      url: commit.url,
      method: commit.isPost ? 'POST' : 'GET',
      type: commit.parentOrigin === null ? 'main_frame' : 'sub_frame',
      initiator: commit.parentOrigin,
      tabId: commit.tabId,
      topFrameOrigin: commit.topFrameOrigin
    }
    const state = new Map<DnrRulesetMatcher, DnrRequestAction>()
    const context = this.context(request, null)
    if (context === null) {
      return state
    }
    if (commit.committedOrigin !== undefined) {
      // IsThirdPartyRequest compares the committed origin, not the URL, with the parent's.
      const committedHost = dnrOriginHost(commit.committedOrigin)
      const parentHost = dnrOriginHost(commit.parentOrigin)
      context.isThirdParty =
        committedHost === null ||
        parentHost === null ||
        !sameDomainOrHost(committedHost, parentHost)
    }
    for (const extension of this.ordered) {
      extension.collectFrameAllow(context, 'beforeRequest', state)
    }
    // Navigations with response headers also match headers-received allowAllRequests rules.
    const headersContext = commit.responseHeaders
      ? this.context(request, commit.responseHeaders)
      : null
    for (const extension of headersContext ? this.ordered : []) {
      extension.collectFrameAllow(headersContext ?? context, 'headersReceived', state)
    }
    for (const extension of this.ordered) {
      extension.inheritFrameAllow(commit.parentState, state)
    }
    return state
  }

  private context(
    request: DnrRequestInfo,
    responseHeaders: DnrResponseHeaders | null
  ): DnrRequestContext | null {
    const context = createDnrRequestContext(request, responseHeaders)
    if (context !== null) {
      this.postings.distribute(context)
    }
    return context
  }

  private evaluate(
    request: DnrRequestInfo,
    context: DnrRequestContext,
    stage: DnrStage,
    state: DnrRequestState,
    options: DnrEvaluateOptions
  ): DnrEvaluation {
    // Extensions never act on chrome-extension:// requests.
    if (context.url.lowerSpec.startsWith('chrome-extension:')) {
      return emptyDnrEvaluation()
    }
    const withheld: string[] = []
    const evaluated: { extension: DnrExtensionMatcher; access: DnrHostAccess }[] = []
    let best: DnrRequestAction | null = null
    for (const extension of this.ordered) {
      const access = options.hostAccess?.(extension.extensionId) ?? 'allowed'
      if (!this.shouldEvaluate(extension, request, context, access)) {
        continue
      }
      evaluated.push({ extension, access })
      const info = extension.getAction(
        context,
        stage,
        options.frameAllow,
        state.allowByExtension,
        access
      )
      if (info.withheld) {
        withheld.push(extension.extensionId)
      }
      // Ties keep the earlier, more recently installed extension.
      if (crossExtensionRank(info.action) > crossExtensionRank(best)) {
        best = info.action
      }
    }
    if (best !== null && !isAllowAction(best)) {
      return { actions: [best], withheldExtensionIds: withheld }
    }
    const modify: DnrRequestAction[] = []
    for (const { extension, access } of evaluated) {
      if (access === 'denied') {
        continue
      }
      const actions = extension.modifyHeadersActions(context, stage, state.allowByExtension)
      if (access === 'allowed') {
        modify.push(...actions)
      } else if (actions.length > 0) {
        withheld.push(extension.extensionId)
      }
    }
    if (modify.length > 0) {
      return { actions: modify, withheldExtensionIds: withheld }
    }
    return { actions: best ? [best] : [], withheldExtensionIds: withheld }
  }

  /** ShouldEvaluateRulesetForRequest, minus checks the embedder owns (incognito, file access). */
  private shouldEvaluate(
    extension: DnrExtensionMatcher,
    request: DnrRequestInfo,
    context: DnrRequestContext,
    access: DnrHostAccess
  ): boolean {
    const fromOtherExtension =
      request.type !== 'main_frame' &&
      context.initiatorScheme === 'chrome-extension' &&
      context.initiatorHost !== extension.extensionId
    if (fromOtherExtension) {
      return false
    }
    return !(extension.hostPermissionsAlwaysRequired && access === 'denied')
  }

  /** Descending install time, then descending extension id. */
  private reorder(): void {
    this.ordered = [...this.extensions.values()].sort(
      (a, b) =>
        b.installTime - a.installTime ||
        (a.extensionId < b.extensionId ? 1 : a.extensionId > b.extensionId ? -1 : 0)
    )
  }
}
