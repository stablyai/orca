import { z } from 'zod'
import {
  buildMarkdownDiskFallbackDoc,
  MARKDOWN_RENDERER_UNAVAILABLE,
  MARKDOWN_TOO_LARGE_READ_ONLY_REASON
} from '../../../../shared/mobile-markdown-disk-fallback'
import {
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  type RuntimeMarkdownReadTabResult
} from '../../../../shared/mobile-markdown-document'
import { MobileWebRelativePathSchema } from '../../../../shared/mobile-web/file-operation-contract'
import { defineMethod, type RpcContext } from '../core'

const Target = z.object({
  worktree: z.string().min(1).max(4096),
  tabId: z.string().min(1).max(512),
  relativePath: MobileWebRelativePathSchema.optional()
})
const MarkdownTab = z.object({
  id: z.string(),
  type: z.literal('markdown'),
  relativePath: z.string().min(1)
})
export const MOBILE_WEB_MARKDOWN_TAB_METHODS = [
  defineMethod({
    name: 'mobileWeb.markdown.read',
    params: Target.extend({ tabIsDirty: z.boolean() }),
    handler: async (params, context) => {
      const hostRelativePath = await resolveMarkdownTab(params, context)
      const tab = await Promise.resolve(
        context.runtime.readMobileMarkdownTab(params.worktree, params.tabId)
      ).catch((error: unknown) => {
        if (!isRendererUnavailable(error)) {
          throw error
        }
        return null
      })
      return tab === null
        ? readFromDisk(params, hostRelativePath, context)
        : projectReadTab(params, hostRelativePath, tab)
    }
  }),
  defineMethod({
    name: 'mobileWeb.markdown.save',
    params: Target.extend({
      baseVersion: z.string().min(1).max(512),
      contentBase64: z.string().max(markdownBase64MaxCharacters())
    }),
    handler: async (params, context) => {
      const hostRelativePath = await resolveMarkdownTab(params, context)
      // A stale base version is an outcome the page acts on, not a transport failure.
      const result = await Promise.resolve(
        context.runtime.saveMobileMarkdownTab(
          params.worktree,
          params.tabId,
          params.baseVersion,
          decodeMarkdown(params.contentBase64)
        )
      ).catch((error: unknown) => {
        if (isConflict(error)) {
          return null
        }
        throw error
      })
      if (result === null) {
        return { outcome: 'conflict' }
      }
      if (result.tabId !== params.tabId) {
        throw new Error('runtime_unavailable')
      }
      return {
        outcome: 'saved',
        ...pageTarget(params, hostRelativePath),
        contentBase64: encodeMarkdown(clipMarkdown(result.content).content),
        baseVersion: result.version
      }
    }
  })
]

/** The host tab list is the only authority on which file a markdown tab id names. */
async function resolveMarkdownTab(
  params: z.infer<typeof Target>,
  context: RpcContext
): Promise<string> {
  const snapshot = await context.runtime.listMobileSessionTabs(
    params.worktree,
    context.pairedDeviceId
  )
  if (`id:${snapshot.worktree}` !== params.worktree) {
    throw new Error('selector_not_found')
  }
  const tab = MarkdownTab.safeParse(snapshot.tabs.find((entry) => entry.id === params.tabId))
  // A page that could name the path asserts it, so a rename under the tab is refused, not followed.
  if (
    !tab.success ||
    (params.relativePath !== undefined && params.relativePath !== tab.data.relativePath)
  ) {
    throw new Error('selector_not_found')
  }
  return tab.data.relativePath
}

function projectReadTab(
  params: z.infer<typeof Target> & { tabIsDirty: boolean },
  hostRelativePath: string,
  result: RuntimeMarkdownReadTabResult
) {
  if (result.tabId !== params.tabId) {
    throw new Error('runtime_unavailable')
  }
  const readable = clipMarkdown(result.content)
  const readOnlyReason = readable.truncated
    ? MARKDOWN_TOO_LARGE_READ_ONLY_REASON
    : result.readOnlyReason
  return {
    ...pageTarget(params, hostRelativePath),
    contentBase64: encodeMarkdown(readable.content),
    baseVersion: result.version,
    editable: result.editable && !readable.truncated,
    stale: result.isDirty,
    ...(readOnlyReason ? { readOnlyReason } : {})
  }
}

async function readFromDisk(
  params: z.infer<typeof Target> & { tabIsDirty: boolean },
  hostRelativePath: string,
  context: RpcContext
) {
  const result = await context.runtime.readMobileFile(params.worktree, hostRelativePath)
  if (result.relativePath !== hostRelativePath) {
    throw new Error('runtime_unavailable')
  }
  const readable = clipMarkdown(result.content)
  const fallback = buildMarkdownDiskFallbackDoc({
    content: readable.content,
    truncated: result.truncated || readable.truncated,
    tabIsDirty: params.tabIsDirty
  })
  return {
    ...pageTarget(params, hostRelativePath),
    contentBase64: encodeMarkdown(fallback.content),
    baseVersion: fallback.baseVersion,
    editable: fallback.editable,
    stale: fallback.stale,
    readOnlyReason: fallback.readOnlyReason
  }
}

/** A tab opened from outside the worktree has no page-expressible path, so it sends none. */
function pageTarget(params: z.infer<typeof Target>, hostRelativePath: string) {
  const relativePath = MobileWebRelativePathSchema.safeParse(hostRelativePath)
  return {
    tabId: params.tabId,
    ...(relativePath.success ? { relativePath: relativePath.data } : {})
  }
}

/** Reads must survive documents past the edit ceiling: the host already serves those read-only. */
function clipMarkdown(content: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength <= MOBILE_MARKDOWN_EDIT_MAX_BYTES) {
    return { content, truncated: false }
  }
  let end = MOBILE_MARKDOWN_EDIT_MAX_BYTES
  // Never split a UTF-8 sequence; continuation bytes are 0b10xxxxxx.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1
  }
  return { content: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

function encodeMarkdown(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64')
}

function decodeMarkdown(contentBase64: string): string {
  const bytes = Buffer.from(contentBase64, 'base64')
  const content = bytes.toString('utf8')
  if (
    bytes.byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ||
    !Buffer.from(content, 'utf8').equals(bytes)
  ) {
    throw new Error('invalid_argument')
  }
  return content
}

function markdownBase64MaxCharacters(): number {
  return Math.ceil(MOBILE_MARKDOWN_EDIT_MAX_BYTES / 3) * 4
}

function isRendererUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message === MARKDOWN_RENDERER_UNAVAILABLE
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'conflict'
}
