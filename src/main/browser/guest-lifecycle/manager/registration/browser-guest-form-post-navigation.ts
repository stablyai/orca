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
  started: (url: string, current: { url: string; post: boolean }) => void
  isPost: () => boolean
} {
  let submitted: { url: string; at: number } | null = null
  let post = false
  return {
    submitted: (actionUrl) => {
      submitted = { url: withoutHash(actionUrl), at: performance.now() }
    },
    // Errs toward protecting: a redirected POST keeps the mark (307/308 keep the method), and
    // so does reloading a POST result, which posts again without a new submission.
    started: (url, current) => {
      post =
        (submitted !== null &&
          performance.now() - submitted.at < FORM_POST_NAVIGATION_MS &&
          withoutHash(url) === submitted.url) ||
        (current.post && withoutHash(url) === withoutHash(current.url))
      submitted = null
    },
    isPost: () => post
  }
}
