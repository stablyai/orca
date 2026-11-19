const FORM_POST_NAVIGATION_MS = 1_000

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
 * submitted form. Only a navigation that starts at that form's action URL right after it counts,
 * so a submission a page handles without navigating can't mark a later page.
 */
export function createFormPostNavigationTracker(): {
  submitted: (actionUrl: string) => void
  started: (url: string) => void
  redirected: () => void
  isPost: () => boolean
} {
  let submitted: { url: string; at: number } | null = null
  let post = false
  return {
    submitted: (actionUrl) => {
      submitted = { url: withoutHash(actionUrl), at: performance.now() }
    },
    started: (url) => {
      post =
        submitted !== null &&
        performance.now() - submitted.at < FORM_POST_NAVIGATION_MS &&
        withoutHash(url) === submitted.url
      submitted = null
    },
    // A 301/302/303 turns the POST into a GET, and the GET result reloads safely.
    redirected: () => {
      post = false
    },
    isPost: () => post
  }
}
