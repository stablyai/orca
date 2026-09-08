import { MARKDOWN_RENDERER_UNAVAILABLE } from '../../../src/shared/mobile-markdown-disk-fallback'
import type { RpcFailure } from '../transport/types'

export function shouldReadMarkdownFromDiskAfterReadTabFailure(response: RpcFailure): boolean {
  return (
    response.error.code === MARKDOWN_RENDERER_UNAVAILABLE ||
    (response.error.code === 'runtime_error' &&
      response.error.message === MARKDOWN_RENDERER_UNAVAILABLE)
  )
}
