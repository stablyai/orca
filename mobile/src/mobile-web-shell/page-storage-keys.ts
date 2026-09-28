/**
 * Which of the app's stored keys the page may read and write, and how much of each.
 *
 * AsyncStorage's web build is `window.localStorage`, which the page does not have: Android turns
 * DOM storage off and on iOS the origin host is the session id, so anything written there is empty
 * again on the next remount. A pin that silently forgets itself is worse than one that cannot be
 * set, so the page's store is the app's, reached over the `storage` grant.
 *
 * An allowlist and not a passthrough. Everything the app keeps under `orca:` is in one namespace —
 * push registrations, the hybrid shell flag itself — and a page that could write any of them could
 * turn the feature on for a build that never offered it. A prefix is listed only where the key
 * carries an id the desktop chooses; the rest are exact.
 *
 * Every key here was read off a page route's own closure rather than taken from a list: a key a
 * screen reads and this file does not name is a preference that silently falls back to its default
 * inside the page and keeps working outside it, which is the failure the grant exists to end
 * (rulings-ota-c7.md ruling 7).
 */
export const PAGE_STORAGE_EXACT_KEYS = [
  /** The repo the New Workspace drawer opens on. */
  'orca:last-visited-worktree',
  /** The worktree-list sidebar's width, which `app/h/_layout.tsx` renders above every page route. */
  'orca:hostSidebarWidth',
  /** The session screen's docked panel width, dragged by `use-mobile-dock-resize.ts`. */
  'orca:hostDockWidth',
  /** The terminal accessory bar's order and visibility. */
  'orca:terminal-accessory-layout',
  /** The user's own accessory keys, which `CustomKeyModal` writes. */
  'orca:custom-accessory-keys',
  /** Whether a supported agent session opens on the terminal or the native chat. */
  'orca:defaultSessionView',
  /** The durable send journal: which `agentSession.send` operation ids are still unsettled. */
  'orca:mobileStructuredSendOperations:v1',
  /** The terminal's text scale, which pinch-to-zoom writes. */
  'orca:terminalTextScale',
  /** Whether the terminal's command inputs offer autocorrect. */
  'orca:terminalAutocompleteEnabled',
  /** Whether a terminal link opens in Orca's browser or the phone's. */
  'orca:terminalLinkOpenMode'
] as const

export const PAGE_STORAGE_KEY_PREFIXES = [
  /** `orca:pins:<hostId>`: the pinned worktrees of the host whose list the page is showing. */
  'orca:pins:',
  /** `orca:nativeChatTabs:<hostId>:<worktreeId>`: which tabs of one workspace show the chat. */
  'orca:nativeChatTabs:',
  /** `orca:terminalLiveInputDisabled:<hostId>:<worktreeId>`: the handles typing goes around. */
  'orca:terminalLiveInputDisabled:'
] as const

/** Long enough for a host's pinned ids, and far short of what a quota refuses. */
export const PAGE_STORAGE_MAX_VALUE_CHARS = 16 * 1024
export const PAGE_STORAGE_MAX_KEY_CHARS = 256
/** Every allowlisted key at once, which is what `init` carries. */
export const PAGE_STORAGE_MAX_ENTRIES = 32

export function isPageStorageKey(key: string): boolean {
  if (key.length > PAGE_STORAGE_MAX_KEY_CHARS) {
    return false
  }
  return (
    PAGE_STORAGE_EXACT_KEYS.some((allowed) => allowed === key) ||
    PAGE_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length)
  )
}

/**
 * The workspace a page route names, or null for a route that names none.
 *
 * Two of the keys above are scoped to one workspace as well as one host, and both sides of the
 * bridge have to agree on which: the shell builds `init` from it and the page holds its writes to
 * it. Derived from the pathname rather than passed down, because the pathname is the one thing both
 * sides are given — the shell is handed the route it opened and the page reads the same route out
 * of `init`, and a second channel for the same fact is how the two would disagree.
 *
 * The session route is the only pattern with a workspace segment *and* keys of its own, so it is
 * the only one read here; the files, review and source-control routes carry a `worktreeId` and no
 * per-workspace key, and a route that grows one adds its pattern here beside this one.
 */
export function pageRouteWorkspace(
  pathname: string
): { hostId: string; worktreeId: string } | null {
  const segments = pathname.split('/')
  if (segments.length !== 5 || segments[0] !== '' || segments[1] !== 'h') {
    return null
  }
  if (segments[3] !== 'session') {
    return null
  }
  try {
    const hostId = decodeURIComponent(segments[2] ?? '')
    const worktreeId = decodeURIComponent(segments[4] ?? '')
    return hostId === '' || worktreeId === '' ? null : { hostId, worktreeId }
  } catch {
    // A stray `%` is not an escape. The route would have been refused upstream; answering null
    // here means the page is handed no workspace key rather than a key built from rubbish.
    return null
  }
}

/** Both workspace-scoped keys are built the same way, so the shape is written once. */
function workspaceScopedKey(prefix: string, hostId: string, worktreeId: string): string {
  return `${prefix}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

/**
 * The keys the shell reads out of the app's store and hands the page in `init`.
 *
 * Filtered through `isPageStorageKey` rather than trusted: a workspace id long enough to push its
 * key past `PAGE_STORAGE_MAX_KEY_CHARS` would otherwise put a key in `init` that the page's own
 * schema refines away, and the page refuses the whole frame rather than that one key.
 */
export function pageStorageKeysForRoute(hostId: string, routePathname: string): string[] {
  const workspace = pageRouteWorkspace(routePathname)
  const scoped =
    workspace === null || workspace.hostId !== hostId
      ? []
      : [
          workspaceScopedKey('orca:nativeChatTabs:', hostId, workspace.worktreeId),
          workspaceScopedKey('orca:terminalLiveInputDisabled:', hostId, workspace.worktreeId)
        ]
  return [...PAGE_STORAGE_EXACT_KEYS, `orca:pins:${hostId}`, ...scoped].filter(isPageStorageKey)
}

/**
 * The allowlist narrowed to one session, which is the one every write is actually held to.
 *
 * `isPageStorageKey` answers for the shape, so `orca:pins:<any host>` passes it; a page opened for
 * one host could therefore rewrite another's pinned list, which is not a key it was ever handed.
 * The same holds one level further in for the two workspace-scoped keys: a session page opened on
 * one workspace must not rewrite another's chat tabs. What the page may write is exactly what it
 * was given, so this is that same list.
 */
export function isPageStorageKeyForRoute(
  key: string,
  hostId: string,
  routePathname: string
): boolean {
  return (
    key.length <= PAGE_STORAGE_MAX_KEY_CHARS &&
    pageStorageKeysForRoute(hostId, routePathname).includes(key)
  )
}

/**
 * Whether the page opened for this route may write this key, which is three refusals in one.
 *
 * Not this page's host or route, not a key it was ever told about, or one the shell could not hand
 * it for size (ruling 33.6). The last is the one the page cannot be trusted with: a document
 * served from an older desktop bundle does not read `storageOversize`, so an allowlisted key it
 * holds no value for would be written whole and replace what the device has. Decided here so the
 * host and the page's own shim answer the same question.
 */
export function pageMayWriteStorageKey(
  key: string,
  hostId: string,
  route: { pathname: string } | null,
  held: PageStorageForInit
): boolean {
  return (
    route !== null &&
    isPageStorageKeyForRoute(key, hostId, route.pathname) &&
    !held.storageOversize.includes(key)
  )
}

/** What `init` carries about the app's store: the values, and the keys it could not carry. */
export type PageStorageForInit = {
  storage: Readonly<Record<string, string>>
  storageOversize: readonly string[]
}

/**
 * The allowlisted values as `init` may carry them: nothing over the caps the page's schema refines
 * on, and the names of whatever was left out.
 *
 * The send journal is why this exists and is not a hypothetical. Measured on this tree: one entry
 * with no attachment costs 343 characters in the array — 342 of its own plus the comma that joins
 * it — so 47 unsettled sends measure 16,140 and 48 measure 16,483, past
 * `PAGE_STORAGE_MAX_VALUE_CHARS`, and the journal's own schema admits 4,096 of them. Handed to
 * `init` whole, the page's `BridgeInitStorageSchema` refuses the *frame* — not the key — and the
 * session screen never opens at all. Dropping the key instead leaves the page reading a default,
 * which is what `dropped` is for: a degradation the caller can name rather than a page that does
 * not start.
 *
 * `oversize` is the half of `dropped` the page must be told about, and it is a correctness matter
 * rather than a diagnostic one (ruling 33.6). A dropped key is still in
 * `pageStorageKeysForRoute`, so the page may write it — and for the journal that is destructive:
 * the page reads no journal, builds an empty one, and its first send writes a one-entry value over
 * the device's, losing every native entry and issuing a fresh `operationId` for an operation
 * native already holds. Named here, the page refuses the write instead. Only the value-cap drops
 * qualify: an entry-cap drop is a key that fits and did not make the frame, and the page's own
 * write of it is the same size the shell would have carried.
 */
export function pageStorageEntriesForInit(held: Readonly<Record<string, string>>): {
  entries: Record<string, string>
  dropped: string[]
  oversize: string[]
} {
  const entries: Record<string, string> = {}
  const dropped: string[] = []
  const oversize: string[] = []
  for (const [key, value] of Object.entries(held)) {
    if (value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
      dropped.push(key)
      oversize.push(key)
      continue
    }
    if (Object.keys(entries).length >= PAGE_STORAGE_MAX_ENTRIES) {
      dropped.push(key)
      continue
    }
    entries[key] = value
  }
  return { entries, dropped, oversize }
}
