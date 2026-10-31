import { compareActions, isAllowAction, type DnrRequestAction } from './ruleset-matcher'

// What WebRequestInfo carries for one request between onBeforeRequest and onHeadersReceived
// (dnr_actions, max_priority_allow_action), and the event router's merge between the stages
// (extension_web_request_event_router.cc OnHeadersReceived, web_request_info.cc).

/** Kept by the caller for one request id across onBeforeRequest and onHeadersReceived. */
export type DnrRequestState = {
  allowByExtension: Map<string, DnrRequestAction | null>
  /** WebRequestInfo::dnr_actions: header modifications still to apply. */
  actions: DnrRequestAction[]
}

export type DnrEvaluation = {
  /** One block/collapse/redirect/upgradeScheme/allow/allowAllRequests action, or modifyHeaders actions. */
  actions: DnrRequestAction[]
  /** Extensions whose action was dropped for lack of host access (for the "wants access" UI). */
  withheldExtensionIds: string[]
  /** onHeadersReceived only: whether an allow matched here should be reported as matched. */
  reportAllowMatch?: boolean
}

export function createDnrRequestState(): DnrRequestState {
  return { allowByExtension: new Map(), actions: [] }
}

export function emptyDnrEvaluation(): DnrEvaluation {
  return { actions: [], withheldExtensionIds: [] }
}

/** Cross-extension precedence: block > redirect/upgrade > allow (RulesetManager::GetAction). */
export function crossExtensionRank(action: DnrRequestAction | null): number {
  if (action === null) {
    return 0
  }
  if (action.type === 'block' || action.type === 'collapse') {
    return 3
  }
  return action.type === 'redirect' || action.type === 'upgradeScheme' ? 2 : 1
}

/** ShouldRecordMatchedAllowRuleInOnHeadersReceived. */
function shouldReportAllow(allow: DnrRequestAction, remaining: DnrRequestAction[]): boolean {
  if (remaining.length === 0) {
    return true
  }
  const onlyRequestHeaders = remaining.every(
    (action) => action.type === 'modifyHeaders' && (action.responseHeaders?.length ?? 0) === 0
  )
  if (onlyRequestHeaders) {
    return true
  }
  return isAllowAction(remaining[0]) && allow.rule.extensionId !== remaining[0].rule.extensionId
}

/**
 * Folds an onHeadersReceived evaluation into the request state. `extensionOrder` lists
 * extension ids by precedence (most recently installed first).
 */
export function mergeHeadersReceived(
  state: DnrRequestState,
  evaluation: DnrEvaluation,
  extensionOrder: readonly string[]
): DnrEvaluation {
  const first = evaluation.actions.at(0)
  if (first === undefined || (!isAllowAction(first) && first.type !== 'modifyHeaders')) {
    return evaluation
  }
  // EraseOutprioritizedDNRActions: an allow found now cancels weaker earlier actions.
  state.actions = state.actions.filter(
    (action) =>
      action.indexPriority >=
      (state.allowByExtension.get(action.rule.extensionId)?.indexPriority ?? 0)
  )
  if (isAllowAction(first)) {
    return { ...evaluation, reportAllowMatch: shouldReportAllow(first, state.actions) }
  }
  if (state.actions.at(0)?.type !== 'modifyHeaders') {
    state.actions = evaluation.actions
    return evaluation
  }
  // MergeModifyHeaderActions: extension precedence first, then action priority.
  const rank = new Map(extensionOrder.map((extensionId, index) => [extensionId, index]))
  state.actions = [...state.actions, ...evaluation.actions].sort(
    (a, b) =>
      (rank.get(a.rule.extensionId) ?? 0) - (rank.get(b.rule.extensionId) ?? 0) ||
      compareActions(b, a)
  )
  return evaluation
}
