import { z } from 'zod'
import { createDnrRequestState, DnrEngine } from '../declarative-net-request/engine'
import type { DnrHostAccess } from '../declarative-net-request/extension-matcher'
import { compareActions, type DnrRequestAction } from '../declarative-net-request/ruleset-matcher'
import { DNR_REQUEST_METHODS, DNR_RESOURCE_TYPES } from '../declarative-net-request/rule-types'
import { BrowserExtensionApiError } from '../browser-extension-namespace-registry'
import type { DnrExtensionRules } from '../browser-extension-dnr-extension-rules'
import { DNR_ERRORS } from '../browser-extension-dnr-limits'

export const testMatchRequestSchema = z
  .object({
    url: z.string(),
    initiator: z.string().optional(),
    method: z.enum(DNR_REQUEST_METHODS).optional(),
    type: z.enum(DNR_RESOURCE_TYPES),
    tabId: z.number().int().optional(),
    responseHeaders: z.record(z.string(), z.array(z.string())).optional(),
    topUrl: z.string().optional()
  })
  .loose()

function parseUrl(raw: string, error: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new BrowserExtensionApiError(error)
  }
}

function matchedRule(action: DnrRequestAction): { ruleId: number; rulesetId: string } {
  return { ruleId: action.rule.ruleId, rulesetId: action.rule.rulesetId }
}

/**
 * testMatchOutcome: this extension's rules alone against a made-up request, combined across the
 * two stages as Chrome does. Indexes are shared, so the throwaway engine only adds lookup tables.
 */
export function testDnrMatchOutcome(
  rules: DnrExtensionRules,
  request: z.infer<typeof testMatchRequestSchema>,
  hostAccess: (extensionId: string) => DnrHostAccess
): { matchedRules: { ruleId: number; rulesetId: string }[] } {
  const url = parseUrl(request.url, DNR_ERRORS.invalidTestUrl)
  const initiator =
    request.initiator === undefined
      ? null
      : parseUrl(request.initiator, DNR_ERRORS.invalidTestInitiator).origin
  if (request.tabId !== undefined && request.tabId < -1) {
    throw new BrowserExtensionApiError(DNR_ERRORS.invalidTestTabId)
  }
  const topFrameOrigin =
    request.topUrl === undefined
      ? null
      : parseUrl(request.topUrl, DNR_ERRORS.invalidTestTopUrl).origin
  const engine = new DnrEngine()
  const extensionId = rules.extension.id
  engine.setExtension(extensionId, { installTime: 0 })
  for (const { source, built, disabledRuleIds } of rules.attachedRulesets()) {
    engine.setRuleset(extensionId, source, built.index)
    if (source.kind === 'static') {
      engine.setDisabledStaticRuleIds(extensionId, source.id, disabledRuleIds)
    }
  }
  const info = {
    url: url.href,
    method: request.method ?? 'get',
    type: request.type,
    initiator,
    tabId: request.tabId ?? -1,
    topFrameOrigin
  }
  const state = createDnrRequestState()
  const options = { hostAccess }
  const before = engine.evaluateBeforeRequest(info, state, options).actions
  if (!request.responseHeaders || isIntercepted(before)) {
    return { matchedRules: before.map(matchedRule) }
  }
  const after = engine.evaluateHeadersReceived(
    info,
    request.responseHeaders,
    state,
    options
  ).actions
  const outcome = combineStages(before, after)
  return { matchedRules: outcome.map(matchedRule) }
}

/** The outcome of both stages, in TestMatchOutcomeFunction's order of checks. */
function combineStages(before: DnrRequestAction[], after: DnrRequestAction[]): DnrRequestAction[] {
  const allowPriority = after[0] && isAllow(after[0]) ? after[0].indexPriority : 0
  const kept = before.filter((action) => action.indexPriority >= allowPriority)
  if (kept.length === 0 || isIntercepted(after)) {
    return after
  }
  if (after.length === 0) {
    return kept
  }
  if (isAllow(kept[0])) {
    return after
  }
  if (isAllow(after[0])) {
    return kept
  }
  return [...kept, ...after].sort((left, right) => compareActions(right, left))
}

function isIntercepted(actions: DnrRequestAction[]): boolean {
  const type = actions.at(0)?.type
  return type === 'block' || type === 'collapse' || type === 'redirect' || type === 'upgradeScheme'
}

function isAllow(action: DnrRequestAction): boolean {
  return action.type === 'allow' || action.type === 'allowAllRequests'
}
