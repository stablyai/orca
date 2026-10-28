import { z } from 'zod'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller,
  type BrowserExtensionMethod
} from '../browser-extension-namespace-registry'
import {
  getBrowserExtensionProfileStateStore,
  type BrowserExtensionProfileState
} from '../browser-extension-profile-state-store'

/**
 * chrome.privacy as types.ChromeSetting objects. Orca has no built-in password manager or
 * autofill, so the `services` values are bookkeeping that password managers read back; the
 * network and websites settings report Chrome's defaults and are not controllable here.
 */

const CONTROLLABLE_DEFAULTS: Record<string, boolean> = {
  'services.passwordSavingEnabled': true,
  'services.autofillEnabled': true,
  'services.autofillAddressEnabled': true,
  'services.autofillCreditCardEnabled': true
}

const FIXED_DEFAULTS: Record<string, unknown> = {
  'network.networkPredictionEnabled': true,
  'network.webRTCIPHandlingPolicy': 'default',
  'websites.thirdPartyCookiesAllowed': true,
  'websites.hyperlinkAuditingEnabled': true,
  'websites.referrersEnabled': true,
  'websites.doNotTrackEnabled': false,
  'websites.protectedContentEnabled': true,
  // Off in Orca: no Google error-page suggestions, and Electron ships no Privacy Sandbox APIs.
  'services.alternateErrorPagesEnabled': false,
  'websites.topicsEnabled': false,
  'websites.fledgeEnabled': false,
  'websites.adMeasurementEnabled': false
}

type LevelOfControl =
  | 'not_controllable'
  | 'controlled_by_other_extensions'
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension'

type SettingValue = { value: unknown; levelOfControl: LevelOfControl }

/** Chrome: the most recent setter wins; every other extension sees it as controlled by another. */
export function resolvePrivacySetting(
  setting: string,
  extensionId: string,
  stateByExtension: Record<string, Pick<BrowserExtensionProfileState, 'privacy'>>
): SettingValue {
  if (!(setting in CONTROLLABLE_DEFAULTS)) {
    return { value: FIXED_DEFAULTS[setting], levelOfControl: 'not_controllable' }
  }
  let winner: { extensionId: string; value: unknown; setAt: number } | null = null
  for (const [candidateId, state] of Object.entries(stateByExtension)) {
    const entry = state.privacy[setting]
    if (entry && (!winner || entry.setAt > winner.setAt)) {
      winner = { extensionId: candidateId, value: entry.value, setAt: entry.setAt }
    }
  }
  if (!winner) {
    return {
      value: CONTROLLABLE_DEFAULTS[setting],
      levelOfControl: 'controllable_by_this_extension'
    }
  }
  return {
    value: winner.value,
    levelOfControl:
      winner.extensionId === extensionId
        ? 'controlled_by_this_extension'
        : 'controlled_by_other_extensions'
  }
}

const detailsSchema = z.object({ incognito: z.boolean() }).partial().loose()
const setSchema = z.object({ value: z.unknown(), scope: z.string() }).partial().loose()

function readProfile(caller: BrowserExtensionCaller) {
  return getBrowserExtensionProfileStateStore().readProfile(caller.browserProfileId)
}

function changeSetting(
  caller: BrowserExtensionCaller,
  setting: string,
  value: { value: unknown } | null
): void {
  if (!(setting in CONTROLLABLE_DEFAULTS)) {
    throw new BrowserExtensionApiError(`${setting} cannot be changed in Orca`)
  }
  const before = readProfile(caller)
  getBrowserExtensionProfileStateStore().update(
    caller.browserProfileId,
    caller.extension.id,
    (state) => {
      const privacy = { ...state.privacy }
      if (value) {
        privacy[setting] = { value: value.value, setAt: Date.now() }
      } else {
        delete privacy[setting]
      }
      return { ...state, privacy }
    }
  )
  const after = readProfile(caller)
  emitBrowserExtensionEvent(
    { session: caller.session },
    'privacy',
    `${setting}.onChange`,
    (extension) => {
      const previous = resolvePrivacySetting(setting, extension.id, before)
      const next = resolvePrivacySetting(setting, extension.id, after)
      return previous.value === next.value && previous.levelOfControl === next.levelOfControl
        ? null
        : [next]
    }
  )
}

function settingMethods(setting: string): Record<string, BrowserExtensionMethod> {
  return {
    [`${setting}.get`]: defineBrowserExtensionMethod(
      z.tuple([detailsSchema.optional()]),
      (caller) => resolvePrivacySetting(setting, caller.extension.id, readProfile(caller))
    ),
    [`${setting}.set`]: defineBrowserExtensionMethod(z.tuple([setSchema]), (caller, details) => {
      if (typeof details.value !== 'boolean') {
        throw new BrowserExtensionApiError('The value must be a boolean')
      }
      changeSetting(caller, setting, { value: details.value })
    }),
    [`${setting}.clear`]: defineBrowserExtensionMethod(
      z.tuple([detailsSchema.optional()]),
      (caller) => changeSetting(caller, setting, null)
    )
  }
}

export const PRIVACY_SETTINGS = [
  ...Object.keys(CONTROLLABLE_DEFAULTS),
  ...Object.keys(FIXED_DEFAULTS)
]

export function registerPrivacyNamespace(): void {
  registerBrowserExtensionNamespace('privacy', {
    permission: 'privacy',
    methods: Object.fromEntries(
      PRIVACY_SETTINGS.flatMap((setting) => Object.entries(settingMethods(setting)))
    ),
    events: PRIVACY_SETTINGS.map((setting) => `${setting}.onChange`)
  })
}
