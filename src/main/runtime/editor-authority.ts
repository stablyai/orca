import type { RuntimeNotifier } from './runtime-notifier-contract'

export type EditorAuthority = 'window' | 'host' | 'unavailable'

export type EditorAuthorityHost = {
  getAvailableAuthoritativeWindow(): unknown
  /** True while a registered window's renderer document is alive, authoritative or not. */
  hasLiveWindowDocument(): boolean
  readonly notifier: Pick<
    RuntimeNotifier,
    'openFile' | 'openDiff' | 'readMobileMarkdownTab' | 'saveMobileMarkdownTab'
  > | null
}

/**
 * Who owns editor tabs right now. Derived on every call and never stored: a window owns them from
 * the moment it is assigned (before its document reads the session). The host owns them only when
 * no live window document exists that could later persist a session it read earlier; a live
 * document that is not authoritative (a promotion still settling) leaves them unavailable.
 */
export function resolveEditorAuthority(host: EditorAuthorityHost): EditorAuthority {
  const notifier = host.notifier
  if (
    host.getAvailableAuthoritativeWindow() &&
    notifier?.openFile &&
    notifier.openDiff &&
    notifier.readMobileMarkdownTab &&
    notifier.saveMobileMarkdownTab
  ) {
    return 'window'
  }
  return notifier && host.hasLiveWindowDocument() ? 'unavailable' : 'host'
}

/** Thrown when a host editor change started without a window and one took over before it committed. */
export const EDITOR_AUTHORITY_CHANGED_ERROR = "The computer's Orca window just opened. Try again."

/** Thrown while a window is registered but has not taken over editor tabs yet. */
export const EDITOR_WINDOW_STARTING_ERROR =
  "The computer's Orca window is still starting. Try again."

export function assertHostEditorAuthority(host: EditorAuthorityHost): void {
  const authority = resolveEditorAuthority(host)
  if (authority === 'unavailable') {
    throw new Error(EDITOR_WINDOW_STARTING_ERROR)
  }
  if (authority !== 'host') {
    throw new Error(EDITOR_AUTHORITY_CHANGED_ERROR)
  }
}

export function assertEditorAuthorityAvailable(authority: EditorAuthority): void {
  if (authority === 'unavailable') {
    throw new Error(EDITOR_WINDOW_STARTING_ERROR)
  }
}
