import { z } from 'zod'
import { isDnrRegexSupported } from '../declarative-net-request/regex-filter'
import { hasBrowserExtensionActiveTab } from '../browser-extension-active-tab'
import { DnrApiError, type DnrExtensionRules } from '../browser-extension-dnr-extension-rules'
import { DNR_ERRORS } from '../browser-extension-dnr-limits'
import { getDnrSessionRuntime, type DnrSessionExtension } from '../browser-extension-dnr-session'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  extensionHasPermission,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { resolveBrowserExtensionTab } from '../browser-extension-tab-model'
import { testDnrMatchOutcome, testMatchRequestSchema } from './declarative-net-request-test-match'

/**
 * chrome.declarativeNetRequest. Electron 43 accepts every call and enforces nothing, so Orca
 * replaces the namespace in workers and extension pages and owns the rules
 * (browser-extension-dnr-session.ts). onRuleMatchedDebug stays native: Chrome offers it only to
 * unpacked extensions, for debugging.
 */
export const DNR_NAMESPACE_PERMISSIONS = [
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess'
] as const

const ruleIdsSchema = z.array(z.number().int())
const updateRulesSchema = z
  .object({ removeRuleIds: ruleIdsSchema.optional(), addRules: z.array(z.unknown()).optional() })
  .loose()
const ruleFilterSchema = z.object({ ruleIds: ruleIdsSchema.optional() }).loose().optional()
const updateRulesetsSchema = z
  .object({
    enableRulesetIds: z.array(z.string()).optional(),
    disableRulesetIds: z.array(z.string()).optional()
  })
  .loose()
const updateStaticRulesSchema = z
  .object({
    rulesetId: z.string(),
    disableRuleIds: ruleIdsSchema.optional(),
    enableRuleIds: ruleIdsSchema.optional()
  })
  .loose()
const regexOptionsSchema = z
  .object({
    regex: z.string(),
    isCaseSensitive: z.boolean().optional(),
    requireCapturing: z.boolean().optional()
  })
  .loose()
const actionOptionsSchema = z
  .object({
    displayActionCountAsBadgeText: z.boolean().optional(),
    tabUpdate: z.object({ tabId: z.number().int(), increment: z.number().int() }).optional()
  })
  .loose()
const matchedRulesFilterSchema = z
  .object({ tabId: z.number().int().optional(), minTimeStamp: z.number().optional() })
  .loose()
  .optional()

function entryFor(caller: BrowserExtensionCaller): DnrSessionExtension {
  const entry = getDnrSessionRuntime(caller.session)?.extensions.get(caller.extension.id)
  if (!entry) {
    throw new BrowserExtensionApiError(DNR_ERRORS.internal)
  }
  return entry
}

/** Rule validation and limit errors reach the extension with Chrome's text. */
async function asApiError<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw error instanceof DnrApiError ? new BrowserExtensionApiError(error.message) : error
  }
}

/** Reads wait for queued updates, as Chrome answers after pending changes land. */
function readAfterUpdates<T>(
  caller: BrowserExtensionCaller,
  read: (rules: DnrExtensionRules) => T
): Promise<T> {
  const { rules } = entryFor(caller)
  return asApiError(() => rules.enqueue(() => read(rules)))
}

function requireTab(caller: BrowserExtensionCaller, tabId: number): void {
  const entry = resolveBrowserExtensionTab(tabId)
  if (!entry || entry.contents.session !== caller.session) {
    throw new BrowserExtensionApiError(DNR_ERRORS.tabNotFound(tabId))
  }
}

function getMatchedRules(
  caller: BrowserExtensionCaller,
  filter: z.infer<typeof matchedRulesFilterSchema>
): unknown {
  const tabId = filter?.tabId
  if (tabId !== undefined && tabId !== -1) {
    requireTab(caller, tabId)
  }
  const permitted =
    extensionHasPermission(caller.extension, 'declarativeNetRequestFeedback', caller.session) ||
    (tabId !== undefined &&
      tabId !== -1 &&
      hasBrowserExtensionActiveTab(caller.extension.id, tabId))
  if (!permitted) {
    throw new BrowserExtensionApiError(DNR_ERRORS.getMatchedRulesPermission)
  }
  const runtime = getDnrSessionRuntime(caller.session)
  return {
    rulesInfo: runtime?.matched.matchedRules(caller.extension.id, filter ?? {}) ?? []
  }
}

function setExtensionActionOptions(
  caller: BrowserExtensionCaller,
  options: z.infer<typeof actionOptionsSchema>
): void {
  const runtime = getDnrSessionRuntime(caller.session)
  const { rules } = entryFor(caller)
  if (options.displayActionCountAsBadgeText !== undefined) {
    runtime?.setDisplayActionCount(caller.extension.id, options.displayActionCountAsBadgeText)
  }
  const update = options.tabUpdate
  if (update) {
    if (!rules.displayActionCountAsBadgeText) {
      throw new BrowserExtensionApiError(DNR_ERRORS.incrementWithoutBadgeText)
    }
    requireTab(caller, update.tabId)
    runtime?.matched.incrementActionCount(caller.extension.id, update.tabId, update.increment)
  }
}

export function registerDeclarativeNetRequestNamespace(): void {
  registerBrowserExtensionNamespace('declarativeNetRequest', {
    permission: DNR_NAMESPACE_PERMISSIONS,
    methods: {
      updateDynamicRules: defineBrowserExtensionMethod(z.tuple([updateRulesSchema]), (caller, o) =>
        asApiError(() =>
          entryFor(caller).rules.updateRules('dynamic', o.removeRuleIds ?? [], o.addRules ?? [])
        )
      ),
      getDynamicRules: defineBrowserExtensionMethod(z.tuple([ruleFilterSchema]), (caller, filter) =>
        readAfterUpdates(caller, (rules) => rules.getRules('dynamic', filter?.ruleIds))
      ),
      updateSessionRules: defineBrowserExtensionMethod(z.tuple([updateRulesSchema]), (caller, o) =>
        asApiError(() =>
          entryFor(caller).rules.updateRules('session', o.removeRuleIds ?? [], o.addRules ?? [])
        )
      ),
      getSessionRules: defineBrowserExtensionMethod(z.tuple([ruleFilterSchema]), (caller, filter) =>
        readAfterUpdates(caller, (rules) => rules.getRules('session', filter?.ruleIds))
      ),
      updateEnabledRulesets: defineBrowserExtensionMethod(
        z.tuple([updateRulesetsSchema]),
        (caller, options) =>
          asApiError(() =>
            entryFor(caller).rules.updateEnabledRulesets(
              options.enableRulesetIds ?? [],
              options.disableRulesetIds ?? []
            )
          )
      ),
      getEnabledRulesets: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        readAfterUpdates(caller, (rules) => rules.enabledRulesetIds())
      ),
      updateStaticRules: defineBrowserExtensionMethod(
        z.tuple([updateStaticRulesSchema]),
        (caller, options) =>
          asApiError(() =>
            entryFor(caller).rules.updateStaticRules(
              options.rulesetId,
              options.disableRuleIds ?? [],
              options.enableRuleIds ?? []
            )
          )
      ),
      getDisabledRuleIds: defineBrowserExtensionMethod(
        z.tuple([z.object({ rulesetId: z.string() }).loose()]),
        (caller, options) =>
          readAfterUpdates(caller, (rules) => rules.disabledRuleIdsFor(options.rulesetId))
      ),
      getAvailableStaticRuleCount: defineBrowserExtensionMethod(z.tuple([]), (caller) =>
        readAfterUpdates(
          caller,
          (rules) =>
            (getDnrSessionRuntime(caller.session)?.staticRuleLimit(caller.extension.id) ?? 0) -
            rules.staticRuleCount()
        )
      ),
      isRegexSupported: defineBrowserExtensionMethod(z.tuple([regexOptionsSchema]), (_c, options) =>
        isDnrRegexSupported(options)
      ),
      testMatchOutcome: defineBrowserExtensionMethod(
        z.tuple([testMatchRequestSchema]),
        (caller, request) => {
          const { rules, hostAccess } = entryFor(caller)
          return testDnrMatchOutcome(rules, request, () =>
            hostAccess.access(request.url, request.initiator ?? null, request.tabId ?? -1)
          )
        }
      ),
      setExtensionActionOptions: defineBrowserExtensionMethod(
        z.tuple([actionOptionsSchema]),
        setExtensionActionOptions
      ),
      getMatchedRules: defineBrowserExtensionMethod(
        z.tuple([matchedRulesFilterSchema]),
        getMatchedRules
      )
    },
    events: []
  })
}
