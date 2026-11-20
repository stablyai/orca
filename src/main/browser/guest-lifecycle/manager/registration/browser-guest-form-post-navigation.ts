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
  /** `frame` is the reporting frame's tree node id. */
  submitted: (actionUrl: string, frame: number) => void
  /** The page cancelled, intercepted or aborted the navigation of the submission to this URL. */
  cancelled: (actionUrl: string) => void
  /** `initiator` is the tree node id of the frame that started it, null for the browser itself. */
  started: (url: string, initiator: number | null) => void
  /** `method` is the request's own method when a request listener saw it. */
  committed: (url: string, method: string | null) => boolean
  /** The committed document was a fresh navigation; true if that drops a remembered POST mark. */
  freshlyNavigated: () => boolean
} {
  // Each frame's latest report; only a navigation that frame starts can be its submission, so a
  // report whose navigation never came can't mark a link or address-bar visit.
  const submitted = new Map<number, string>()
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
    submitted: (actionUrl, frame) => {
      submitted.set(frame, withoutHash(actionUrl))
    },
    cancelled: (actionUrl) => {
      const url = withoutHash(actionUrl)
      for (const [frame, reported] of submitted) {
        if (reported === url) {
          submitted.delete(frame)
        }
      }
    },
    started: (url, initiator) => {
      if (provisionalUrl !== null) {
        remember(provisionalUrl)
        provisionalUrl = null
      }
      const target = withoutHash(url)
      startTarget = target
      const submission = initiator !== null && submitted.get(initiator) === target
      fromMemory = !submission && postResultUrls.has(target)
      post = submission || fromMemory
      submitted.clear()
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
