import { isPageStorageKeyForRoute, PAGE_STORAGE_MAX_VALUE_CHARS } from '../page-storage-keys'

/**
 * The page's AsyncStorage: the app's store, read from `init` and written over the `storage` grant.
 *
 * AsyncStorage's web build is `window.localStorage`, and the page has none worth having — Android
 * turns DOM storage off, and on iOS the origin host is the session id, so every remount starts
 * empty. A pin that silently forgets itself is worse than one that cannot be set, so this holds the
 * app's own values instead: `init` primes them, a write is applied here and posted, and the app is
 * where it lands.
 *
 * Reads are synchronous against that cache behind an async surface, which is what the real module
 * is too. Nothing here waits on the shell: a write the shell drops is a write the next `init`
 * corrects, and a read that waited for a round trip would change what the first render sees.
 */
type PageStorageWriter = (key: string, value: string | null) => boolean

/** Why a write went nowhere, in the page's own words rather than a boolean. */
type PageStorageRefusal = 'not-allowed' | 'too-large' | 'not-delivered'

const REFUSAL_SENTENCES: Record<PageStorageRefusal, string> = {
  'not-allowed': 'this screen was not given that setting to write',
  'too-large': `a stored value may be at most ${String(PAGE_STORAGE_MAX_VALUE_CHARS)} characters`,
  'not-delivered': 'the app did not take the write'
}

/**
 * A write the page could not make, as something a screen can put on itself.
 *
 * Raised for one refusal only, `too-large`, and that scope is the whole of ruling 33.4. The real
 * AsyncStorage rejects when its store refuses — a value over the row limit is a SQLite error on
 * Android — so rejecting is the module's own contract for a value too big, and the caller that
 * needs it is written for it: the durable send journal, whose composer catches this and answers
 * "Message not sent" rather than sending a mutation whose operation id was never written down
 * (ruling 7).
 *
 * The other two refusals stay silent drops, because nothing catches them. A page-closure writer of
 * an unlisted key calls `setItem` and awaits it with no catch —
 * `notification-delivery-preferences.ts:39` is the plain case, and `preferences.ts` has several —
 * so rejecting there converts a preference the page was never allowed to keep into an unhandled
 * rejection in the document. A write nobody may make and a write the shell would not take are both
 * the page failing to change anything, which is what it already does; the log is where they go.
 */
export class PageStorageRefusedError extends Error {
  readonly refusal: PageStorageRefusal
  readonly key: string

  constructor(key: string, refusal: PageStorageRefusal) {
    super(`Orca could not save ${key}: ${REFUSAL_SENTENCES[refusal]}.`)
    this.name = 'PageStorageRefusedError'
    this.refusal = refusal
    this.key = key
  }
}

const values = new Map<string, string>()
let write: PageStorageWriter = () => false
/**
 * The allowlisted keys `init` could not carry because the app's value was over the page's cap.
 *
 * Writable by the allowlist and unwritable in fact (ruling 33.6): the page holds no value for one
 * of these, so anything it writes replaces what the device has rather than extending it. Refused
 * as `too-large`, which is the truth about the key and the one refusal the composer catches.
 */
let oversizeKeys: ReadonlySet<string> = new Set()
/** The host this document was opened for; no key belonging to another one is writable. */
let hostId = ''
/** And the route, because two of the keys are scoped to the workspace the route names. */
let routePathname = ''

/** Called once by the entry, before anything renders, with what `init` carried. */
export function publishPageStorage(
  entries: Readonly<Record<string, string>>,
  writer: PageStorageWriter,
  forHostId: string,
  forRoutePathname: string,
  forOversizeKeys: readonly string[] = []
): void {
  values.clear()
  oversizeKeys = new Set(forOversizeKeys)
  for (const [key, value] of Object.entries(entries)) {
    values.set(key, value)
  }
  write = writer
  hostId = forHostId
  routePathname = forRoutePathname
}

/**
 * Refused rather than kept locally, and named rather than dropped.
 *
 * A key outside the allowlist is one the shell will not write, so holding it here would answer a
 * later read with a value no other screen in the app can see — a pin that looks set and is not,
 * which is exactly the failure the grant exists to avoid.
 */
function accept(key: string, value: string | null): PageStorageRefusal | null {
  if (!isPageStorageKeyForRoute(key, hostId, routePathname)) {
    return 'not-allowed'
  }
  // The envelope's own bound, imported rather than restated: without it an oversized value is
  // cached here and dropped on the wire, so the page reads back a write no other screen can see.
  if (value !== null && value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
    return 'too-large'
  }
  // And the same refusal for a key whose app-side value was already over it: the page was handed
  // nothing for this key, so any write it makes is a replacement rather than an edit.
  if (oversizeKeys.has(key)) {
    return 'too-large'
  }
  if (!write(key, value)) {
    return 'not-delivered'
  }
  if (value === null) {
    values.delete(key)
  } else {
    values.set(key, value)
  }
  return null
}

/**
 * The error a refusal is, or nothing. Logged here, because the drop is the thing a reader of a
 * device log has to be able to find — a preference that did not stick looks identical to one
 * nobody set.
 *
 * An error rather than a rejected promise, so a caller that raises no rejection creates none. A
 * promise built per refusal and then discarded is an unhandled rejection in the page, which is
 * exactly what this module's rejection scope exists to avoid.
 */
function refusalError(
  key: string,
  refusal: PageStorageRefusal | null
): PageStorageRefusedError | null {
  if (refusal === null) {
    return null
  }
  if (refusal === 'too-large') {
    return new PageStorageRefusedError(key, refusal)
  }
  console.warn('[page-bridge] storage-write-dropped', { key, refusal })
  return null
}

/** One refusal: the rejection the composer's catch is written for, or a logged drop. */
function settle(key: string, refusal: PageStorageRefusal | null): Promise<void> {
  const error = refusalError(key, refusal)
  return error === null ? Promise.resolve() : Promise.reject(error)
}

/**
 * A batch is one call with one answer, so it stops where it cannot go on: every pair before the
 * refusal is applied, the refusal is the answer, and nothing after it is attempted (ruling 35).
 *
 * What this replaces collected a refusal per pair, logged each, and rejected with the first that
 * could reject while the rest of the batch went in anyway — one promise describing a call where
 * some pairs landed and some did not, which is the thing a caller cannot act on. No page-closure
 * writer calls `multiSet` or `multiRemove` today, so this is the rule for whoever writes the
 * first one rather than a change to anybody's behaviour.
 */
function applyBatch(pairs: readonly (readonly [string, string | null])[]): Promise<void> {
  for (const [key, value] of pairs) {
    const refusal = accept(key, value)
    if (refusal !== null) {
      return settle(key, refusal)
    }
  }
  return Promise.resolve()
}

const pageAsyncStorage = {
  getItem: (key: string): Promise<string | null> => Promise.resolve(values.get(key) ?? null),
  setItem: (key: string, value: string): Promise<void> => settle(key, accept(key, value)),
  removeItem: (key: string): Promise<void> => settle(key, accept(key, null)),
  multiGet: (keys: readonly string[]): Promise<[string, string | null][]> =>
    Promise.resolve(keys.map((key) => [key, values.get(key) ?? null])),
  multiSet: (pairs: readonly [string, string][]): Promise<void> => applyBatch(pairs),
  multiRemove: (keys: readonly string[]): Promise<void> =>
    applyBatch(keys.map((key) => [key, null] as const)),
  getAllKeys: (): Promise<string[]> => Promise.resolve([...values.keys()]),
  // The app's store is not this document's to empty, and no screen in the page closure calls it.
  clear: (): Promise<void> => Promise.resolve()
}

export default pageAsyncStorage
