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
  let committedUrl: string | null = null
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
    // A POST's redirect (Post/Redirect/Get) loads its target with GET; Electron doesn't report the
    // status, and the method-keeping 307/308 are rare for form results.
    redirected: () => {
      post = false
      fromMemory = false
    },
    committed: (url, method) => {
      const isPost = method !== null ? method !== 'GET' : post
      const target = withoutHash(url)
      fromMemory = fromMemory && method === null
      committedUrl = target
      if (isPost) {
        postResultUrls.delete(target)
        postResultUrls.add(target)
        if (postResultUrls.size > MAX_POST_RESULT_URLS) {
          postResultUrls.delete(postResultUrls.values().next().value ?? target)
        }
      }
      return isPost
    },
    freshlyNavigated: () => {
      if (!fromMemory || committedUrl === null) {
        return false
      }
      fromMemory = false
      post = false
      postResultUrls.delete(committedUrl)
      return true
    }
  }
}
