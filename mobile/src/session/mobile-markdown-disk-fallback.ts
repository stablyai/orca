import type { RpcFailure } from '../transport/types'

const RENDERER_UNAVAILABLE = 'renderer_unavailable'

export function shouldReadMarkdownFromDiskAfterReadTabFailure(response: RpcFailure): boolean {
  return (
    response.error.code === RENDERER_UNAVAILABLE ||
    (response.error.code === 'runtime_error' && response.error.message === RENDERER_UNAVAILABLE)
  )
}

// `truncated` is optional because the preview reader salvages it: an absent flag reads as not
// truncated here, which is the branch main took for a reply that omitted it.
export function buildMarkdownDiskFallbackDoc(args: {
  content: string
  truncated: boolean | undefined
  tabIsDirty: boolean
}) {
  const readOnlyReason = args.truncated
    ? 'File too large for mobile preview'
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
