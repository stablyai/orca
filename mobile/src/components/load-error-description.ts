import type { Translate } from '../i18n/mobile-i18n'

export type LoadErrorDescription = {
  message: string
  /** Raw host or transport text, shown only behind a Details disclosure. */
  details: string | null
}

const TRANSPORT_FAILURE =
  /\bE(CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|NOTFOUND|HOSTUNREACH)\b|socket|connection (closed|lost|reset)|timed out/i
// Stack frames, Node error tags, RPC codes and method names are not sentences a person can act on.
const RAW_TEXT =
  /\n|\bat \S+ \(|\(node:|\b[a-z]+_(error|not_found|failed)\b|\b[a-z]+\.[a-zA-Z]+ failed\b/

/** Turns a load failure into one translated sentence, keeping raw text for Details. */
export function describeLoadError(error: unknown, t: Translate): LoadErrorDescription {
  const raw = (
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  ).trim()
  const generic = t('common.loadError.generic', 'Something went wrong. Try again.')
  if (!raw) {
    return { message: generic, details: null }
  }
  if (TRANSPORT_FAILURE.test(raw)) {
    return {
      message: t('common.loadError.unreachable', "Couldn't reach the desktop. Try again."),
      details: raw
    }
  }
  if (RAW_TEXT.test(raw) || raw.length > 160) {
    return { message: generic, details: raw }
  }
  return { message: raw, details: null }
}
