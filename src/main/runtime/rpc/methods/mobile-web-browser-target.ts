import { z } from 'zod'

/** The shell rewrites the page's workspace handle into `worktree`; `page` is the host browser page
 * id the page already holds from `mobileWeb.session.createBrowser`. */
export const MobileWebBrowserTarget = z.object({
  worktree: z.string().min(1).max(4096),
  page: z.string().min(1).max(512)
})

export const MOBILE_WEB_BROWSER_APPLIED = { applied: true } as const

export const MobileWebBrowserCoordinate = z.number().finite().min(-100_000).max(100_000)

export function mobileWebBrowserTargetFields(params: z.infer<typeof MobileWebBrowserTarget>): {
  worktree: string
  page: string
} {
  return { worktree: params.worktree, page: params.page }
}
