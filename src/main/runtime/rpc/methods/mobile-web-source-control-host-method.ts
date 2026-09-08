import { z } from 'zod'

export const MobileWebWorktreeScope = z.object({ worktree: z.string().min(1).max(4096) })

/** The page never sees a workspace handle in a wrapper result: the shell rewrote its own handle
 * into `worktree`, so the projection carries this placeholder and the page restores its handle. */
export const MOBILE_WEB_PAGE_IDENTITY = 'page'
