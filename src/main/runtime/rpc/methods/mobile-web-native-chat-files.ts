import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { FILE_METHODS } from './files'
import { MOBILE_WEB_FILE_READ_METHODS } from './mobile-web-file-reads'
import { MobileWebChatTarget, resolveMobileWebNativeChat } from './mobile-web-native-chat-binding'
import { MobileWebRelativePathSchema } from '../../../../shared/mobile-web/bridge-operation-contract'

function fileMethod(name: string) {
  const method = [...FILE_METHODS, ...MOBILE_WEB_FILE_READ_METHODS].find(
    (entry) => entry.name === name
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing file method: ${name}`)
  }
  return method
}
const search = fileMethod('mobileWeb.files.searchPaths')
const resolve = fileMethod('files.resolveTerminalPath')
const open = fileMethod('files.open')

export const MOBILE_WEB_NATIVE_CHAT_FILE_METHODS = [
  defineMethod({
    name: 'mobileWeb.nativeChat.fileSearch',
    params: MobileWebChatTarget.extend({ search: z.record(z.string(), z.unknown()) }),
    handler: async (params, context) => {
      await resolveMobileWebNativeChat(context, params)
      return search.handler(
        search.params!.parse({ ...params.search, worktree: params.worktree }),
        context
      )
    }
  }),
  defineMethod({
    name: 'mobileWeb.nativeChat.openFile',
    params: MobileWebChatTarget.extend({
      pathText: z.string().min(1).max(4096),
      timeoutMs: z.number().int().min(1).max(15_000)
    }),
    handler: async (params, context) => {
      const deadline = Date.now() + params.timeoutMs
      const checkDispatch = () => {
        if (context.signal?.aborted || Date.now() >= deadline) {
          throw new Error('runtime_unavailable')
        }
      }
      checkDispatch()
      const binding = await resolveMobileWebNativeChat(context, params)
      const resolved = await resolve.handler(
        resolve.params!.parse({
          worktree: params.worktree,
          pathText: params.pathText,
          terminal: binding.terminal
        }),
        context
      )
      const relativePath = resolvedWorktreePath(resolved)
      if (!relativePath) {
        return { opened: false }
      }
      checkDispatch()
      const result = await open.handler(
        open.params!.parse({ worktree: params.worktree, relativePath }),
        context
      )
      if (!isRecord(result) || typeof result.opened !== 'boolean') {
        throw new Error('Invalid file open result')
      }
      return { opened: result.opened }
    }
  })
]

function resolvedWorktreePath(result: unknown): string | null {
  if (!isRecord(result) || result.exists !== true || result.isDirectory === true) {
    return null
  }
  const target = result.openTarget
  if (target !== undefined && (!isRecord(target) || target.kind !== 'worktree-file')) {
    return null
  }
  const path = isRecord(target) ? target.relativePath : result.relativePath
  const parsed = MobileWebRelativePathSchema.safeParse(path)
  return parsed.success ? parsed.data : null
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
