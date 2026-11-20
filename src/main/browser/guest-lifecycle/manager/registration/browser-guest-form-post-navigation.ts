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
 * POST result stays one for reloads and Back/Forward, which repeat or restore the POST.
 */
export function createFormPostNavigationTracker(): {
  submitted: (actionUrl: string) => void
  started: (url: string) => void
  redirected: () => void
  /** `method` is the request's own method when a request listener saw it. */
  committed: (url: string, method: string | null) => boolean
  /** The committed document was a fresh navigation; true if that drops a remembered POST mark. */
  freshlyNavigated: () => boolean
} {
  let submitted: string | null = null
  let post = false
  // The mark came only from a remembered POST result, which a fresh GET navigation disproves.
  let fromMemory = false
  const postResultUrls = new Set<string>()
  return {
    submitted: (actionUrl) => {
      submitted = withoutHash(actionUrl)
    },
    started: (url) => {
      const target = withoutHash(url)
      fromMemory = target !== submitted && postResultUrls.has(target)
      post = target === submitted || fromMemory
      submitted = null
    },
    // Electron doesn't report a redirect's status, so a 307/308 that keeps the POST can't be told
    // from a Post/Redirect/Get; keeping the page beats restoring a POST result with GET.
    redirected: () => {
      if (fromMemory) {
        post = false
        fromMemory = false
      }
    },
    committed: (url, method) => {
      const isPost = method !== null ? method !== 'GET' : post
      const target = withoutHash(url)
      fromMemory = fromMemory && method === null
      if (isPost) {
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
