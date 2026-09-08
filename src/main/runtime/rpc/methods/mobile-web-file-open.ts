import { z } from 'zod'
import { defineMethod } from '../core'
import { activateMobileWebFileTab } from './mobile-web-file-tab-activation'

export const MOBILE_WEB_FILE_OPEN_METHOD = defineMethod({
  name: 'mobileWeb.files.open',
  params: z.object({
    worktree: z.string().min(1).max(4096),
    relativePath: z.string().min(1).max(4096),
    mode: z.enum(['edit', 'diff']),
    staged: z.boolean().default(false)
  }),
  handler: async (params, context) => {
    await (params.mode === 'diff'
      ? context.runtime.openMobileDiff(params.worktree, params.relativePath, params.staged)
      : context.runtime.openMobileFile(params.worktree, params.relativePath))
    // A tab the host opened but never activated leaves the page on its old route.
    const activated = await activateMobileWebFileTab(
      {
        worktree: params.worktree,
        relativePath: params.relativePath,
        mode: params.mode,
        staged: params.staged
      },
      context
    )
    return { opened: true, activated }
  }
})
