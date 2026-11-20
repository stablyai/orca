// A tab's history rarely holds more POST results than this; the oldest is forgotten first.
const MAX_POST_RESULT_URLS = 50

function withoutHash(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    return url.href
  } catch {
    return rawUrl
  }
}

/**
 * Whether the current main-frame navigation is a form POST, from the preload's report of a
 * submitted form: the next navigation to that form's action URL counts, unless the page cancelled
 * or intercepted it. A page that loaded as a POST result stays one for reloads and Back/Forward,
 * which repeat or restore the POST. A mark survives redirects: Electron doesn't report their
 * status, and a 307/308 keeps the POST.
 */
export function createFormPostNavigationTracker(): {
  submitted: (actionUrl: string) => void
  /** The page cancelled the reported submission's navigation. */
  cancelled: () => void
  /** A same-document navigation; one to the form's address means the page handled it in place. */
  startedInPlace: (url: string) => void
  started: (url: string) => void
  /** `method` is the request's own method when a request listener saw it. */
  committed: (url: string, method: string | null) => boolean
  /** The committed document was a fresh navigation; true if that drops a remembered POST mark. */
  freshlyNavigated: () => boolean
} {
  let submitted: string | null = null
  let post = false
  // The mark came only from a remembered POST result, which a fresh GET navigation disproves.
  let fromMemory = false
  let startTarget = ''
  // A redirect target reached on a memory-only mark: a fresh navigation shows it was a GET page;
  // otherwise (reload or Back/Forward, where a 307/308 re-POSTs) it is remembered at the next start.
  let provisionalUrl: string | null = null
  const postResultUrls = new Set<string>()
  const remember = (url: string): void => {
    postResultUrls.delete(url)
    postResultUrls.add(url)
    if (postResultUrls.size > MAX_POST_RESULT_URLS) {
      postResultUrls.delete(postResultUrls.values().next().value ?? url)
    }
  }
  return {
    submitted: (actionUrl) => {
      submitted = withoutHash(actionUrl)
    },
    cancelled: () => {
      submitted = null
    },
    startedInPlace: (url) => {
      if (submitted === withoutHash(url)) {
        submitted = null
      }
    },
    started: (url) => {
      if (provisionalUrl !== null) {
        remember(provisionalUrl)
        provisionalUrl = null
      }
      const target = withoutHash(url)
      startTarget = target
      const submission = submitted === target
      fromMemory = !submission && postResultUrls.has(target)
      post = submission || fromMemory
      submitted = null
    },
    committed: (url, method) => {
      const isPost = method !== null ? method !== 'GET' : post
      const target = withoutHash(url)
      fromMemory = fromMemory && method === null
      if (isPost) {
        if (fromMemory && target !== startTarget && !postResultUrls.has(target)) {
          provisionalUrl = target
        } else {
          remember(target)
        }
      }
      return isPost
    },
    // The start address stays remembered: an older history entry there is still a POST result.
    freshlyNavigated: () => {
      if (!fromMemory) {
        return false
      }
      fromMemory = false
      post = false
      provisionalUrl = null
      return true
    }
  }
}
