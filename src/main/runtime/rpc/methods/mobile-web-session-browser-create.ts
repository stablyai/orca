import { z } from 'zod'
import { MobileWebSessionBrowserCreatePayloadSchema } from '../../../../shared/mobile-web/session-operation-contract'
import { fileUriToFilesystemPath, filesystemPathToFileUri } from '../../../../shared/file-uri-path'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'
import { BROWSER_CORE_METHODS } from './browser-core'
import { FILE_METHODS } from './files'
import { MobileWebSessionScope } from './mobile-web-session-scope'

const source = BROWSER_CORE_METHODS.find((method) => method.name === 'browser.tabCreate')
const resolver = FILE_METHODS.find((method) => method.name === 'files.resolveTerminalPath')
if (!source || isStreamingMethod(source) || !resolver || isStreamingMethod(resolver)) {
  throw new Error('Missing browser creation dependencies')
}
const create = source
const resolve = resolver

async function browserUrl(url: string, worktree: string, context: RpcContext) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('invalid_params')
  }
  if (parsed.protocol !== 'file:') {
    return url
  }
  const pathText = fileUriToFilesystemPath(parsed)
  if (!pathText) {
    throw new Error('invalid_params')
  }
  const resolved = z
    .object({
      worktree: z.string(),
      exists: z.literal(true),
      isDirectory: z.literal(false),
      openTarget: z.object({
        kind: z.literal('worktree-file'),
        provider: z.literal('local'),
        absolutePath: z.string().min(1).max(4096)
      })
    })
    .parse(await resolve.handler(resolve.params!.parse({ worktree, pathText }), context))
  // The Desktop browser must never interpret an SSH path as a local file.
  assertCanonicalWorktree(resolved.worktree, worktree)
  return filesystemPathToFileUri(resolved.openTarget.absolutePath)
}

// Every creation is scoped to the worktree the page named, whatever the URL scheme.
function assertCanonicalWorktree(hostWorktreeId: string, worktree: string) {
  if (`id:${hostWorktreeId}` !== worktree) {
    throw new Error('selector_not_found')
  }
}

export const MOBILE_WEB_SESSION_BROWSER_CREATE_METHOD = defineMethod({
  name: 'mobileWeb.session.createBrowser',
  params: MobileWebSessionScope.extend({
    url: MobileWebSessionBrowserCreatePayloadSchema.shape.url
  }),
  handler: async (params, context) => {
    const snapshot = await context.runtime.listMobileSessionTabs(
      params.worktree,
      context.pairedDeviceId
    )
    assertCanonicalWorktree(snapshot.worktree, params.worktree)
    const url = await browserUrl(params.url, params.worktree, context)
    if (context.signal?.aborted) {
      throw new Error('runtime_unavailable')
    }
    const result = z
      .object({ browserPageId: z.string().min(1).max(512) })
      .parse(
        await create.handler(
          create.params!.parse({ worktree: params.worktree, url, activate: true }),
          context
        )
      )
    return { workspaceId: params.workspaceId, browserPageId: result.browserPageId }
  }
})
