import type { RpcFailure } from '../transport/types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

export const MARKDOWN_TOO_LARGE_READ_ONLY_REASON = 'File too large for mobile preview'

export function shouldReadMarkdownFromDiskAfterReadTabFailure(response: RpcFailure): boolean {
  return (
    response.error.code === RENDERER_UNAVAILABLE ||
    (response.error.code === 'runtime_error' && response.error.message === RENDERER_UNAVAILABLE)
  )
}

export function buildMarkdownDiskFallbackDoc(args: {
  content: string
  truncated: boolean
  tabIsDirty: boolean
}) {
  const readOnlyReason = args.truncated
    ? MARKDOWN_TOO_LARGE_READ_ONLY_REASON
    : args.tabIsDirty
      ? 'Desktop has unsaved changes. Showing disk content.'
      : 'Editing needs Orca desktop running.'
  return {
    status: 'ready' as const,
    content: args.content,
    localContent: args.content,
    baseVersion: '',
    isDirty: false,
    editable: false,
    stale: args.tabIsDirty,
    readOnlyReason
  }
}
