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
 * submitted form: the next navigation to that form's action URL counts. A page that loaded as a
 * POST result stays one for reloads and Back/Forward, which repeat or restore the POST. A mark
 * survives redirects: Electron doesn't report their status, and a 307/308 keeps the POST.
 */
export function createFormPostNavigationTracker(): {
  submitted: (actionUrl: string) => void
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
  const postResultUrls = new Set<string>()
  return {
    submitted: (actionUrl) => {
      submitted = withoutHash(actionUrl)
    },
    started: (url) => {
      const target = withoutHash(url)
      startTarget = target
      fromMemory = target !== submitted && postResultUrls.has(target)
      post = target === submitted || fromMemory
      submitted = null
    },
    committed: (url, method) => {
      const isPost = method !== null ? method !== 'GET' : post
      const target = withoutHash(url)
      fromMemory = fromMemory && method === null
      // A remembered address that redirected elsewhere proves nothing about the new address.
      if (isPost && !(fromMemory && target !== startTarget)) {
        postResultUrls.delete(target)
        postResultUrls.add(target)
        if (postResultUrls.size > MAX_POST_RESULT_URLS) {
          postResultUrls.delete(postResultUrls.values().next().value ?? target)
        }
      }
      return isPost
    },
    // The address stays remembered: an older history entry there is still a POST result.
    freshlyNavigated: () => {
      if (!fromMemory) {
        return false
      }
      fromMemory = false
      post = false
      return true
    }
  }
}
