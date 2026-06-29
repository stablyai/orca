// Why: mirror src/renderer/src/i18n/i18n.ts:43 so renderer and mobile
// share the same call shape. Keeping the signature identical means future
// shared code (e.g. cross-platform components) can call either side
// without translation.
import { getI18n } from './init'
import type { TOptions } from 'i18next'

export function translate(key: string, fallback: string, options?: TOptions): string {
  // Why: if i18n init failed (corrupt JSON, missing module, no init yet),
  // return the fallback rather than throwing. Throwing would render a
  // white screen for every translated text; the fallback is the same string
  // the user would have seen before this change shipped, so it is a strict
  // UX improvement over crashing.
  try {
    // Why: getI18n() is a module singleton; calling it here keeps the
    // function synchronous, matching the desktop equivalent and allowing
    // use in render bodies, event handlers, and non-component code alike.
    return getI18n().t(key, { defaultValue: fallback, ...options })
  } catch {
    return fallback
  }
}
