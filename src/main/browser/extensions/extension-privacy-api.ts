import { emitExtensionEvent, handleExtensionApi, type ExtensionCaller } from './extension-api-host'
import { objectArg, stringArg } from './extension-api-args'

// What Orca's browser does without extensions: it has no password manager, autofill, or Google
// services, and leaves the network and site defaults as Chromium ships them.
const DEFAULTS: Readonly<Record<string, unknown>> = {
  'services.alternateErrorPagesEnabled': false,
  'services.autofillAddressEnabled': false,
  'services.autofillCreditCardEnabled': false,
  'services.passwordSavingEnabled': false,
  'services.safeBrowsingEnabled': false,
  'services.searchSuggestEnabled': false,
  'services.spellingServiceEnabled': false,
  'services.translationServiceEnabled': false,
  'network.networkPredictionEnabled': true,
  'network.webRTCIPHandlingPolicy': 'default',
  'websites.hyperlinkAuditingEnabled': true,
  'websites.referrersEnabled': true,
  'websites.doNotTrackEnabled': false
}

// Values extensions set, by extension id then setting. Why no effect on the browser: these are
// Chrome's own features, which Orca's browser does not have, so an extension turning one off is
// already true. Keeping the value lets the extension read back what it set.
const setByExtension = new Map<string, Map<string, unknown>>()

function settingPath(value: unknown): string {
  const path = stringArg(value, 'setting')
  if (!(path in DEFAULTS)) {
    throw new Error(`Unknown privacy setting ${path}`)
  }
  return path
}

function describe(caller: ExtensionCaller, path: string) {
  const set = setByExtension.get(caller.extension.id)
  return set?.has(path)
    ? { value: set.get(path), levelOfControl: 'controlled_by_this_extension' }
    : { value: DEFAULTS[path], levelOfControl: 'controllable_by_this_extension' }
}

function changed(caller: ExtensionCaller, path: string): void {
  emitExtensionEvent(
    caller.session,
    `privacy.${path}`,
    [describe(caller, path)],
    caller.extension.id
  )
}

handleExtensionApi('privacy', {
  get: (caller: ExtensionCaller, setting: unknown) => describe(caller, settingPath(setting)),
  set: (caller: ExtensionCaller, setting: unknown, details: unknown) => {
    const path = settingPath(setting)
    const set = setByExtension.get(caller.extension.id) ?? new Map<string, unknown>()
    setByExtension.set(caller.extension.id, set.set(path, objectArg(details).value))
    changed(caller, path)
  },
  clear: (caller: ExtensionCaller, setting: unknown) => {
    const path = settingPath(setting)
    setByExtension.get(caller.extension.id)?.delete(path)
    changed(caller, path)
  }
})
