import type { RpcFailure } from '../transport/types'
import type { MarkdownDocState } from './mobile-session-route-types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

export function shouldReadMarkdownFromDiskAfterReadTabFailure(response: RpcFailure): boolean {
  return (
    response.error.code === RENDERER_UNAVAILABLE ||
    (response.error.code === 'runtime_error' && response.error.message === RENDERER_UNAVAILABLE)
  )
}

export function buildMarkdownDiskFallbackDoc(args: {
  content: string
  truncated?: boolean
  byteLength?: number
  tabIsDirty: boolean
}): Extract<MarkdownDocState, { status: 'ready' }> {
  const readOnlyReason = args.tabIsDirty
    ? 'Desktop has unsaved changes. Showing disk content.'
    : 'Editing needs Orca desktop running.'
  return {
    status: 'ready',
    content: args.content,
    localContent: args.content,
    baseVersion: '',
    isDirty: false,
    editable: false,
    stale: args.tabIsDirty,
    readOnlyReason,
    ...(args.truncated ? { truncated: true, byteLength: args.byteLength } : {})
  }
}
