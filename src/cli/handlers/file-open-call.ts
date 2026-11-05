import type { RuntimeFileOpenResult } from '../../shared/runtime-types'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'

const NO_APP_WINDOW_MESSAGE =
  'This Orca server has no app window, so it cannot open files as tabs. Nothing was opened.'

function isRendererUnavailable(error: unknown): boolean {
  return (
    error instanceof RuntimeClientError &&
    (error.code === 'renderer_unavailable' ||
      (error.code === 'runtime_error' && error.message === 'renderer_unavailable'))
  )
}

/** Keep renderer_unavailable on the wire for mobile fallback; add CLI-specific recovery here. */
export async function callFileOpen(
  ctx: HandlerContext,
  method: 'files.open' | 'files.openDiff',
  params: Record<string, unknown>
): Promise<RuntimeRpcSuccess<RuntimeFileOpenResult>> {
  try {
    return await ctx.client.call<RuntimeFileOpenResult>(method, params)
  } catch (error) {
    if (!isRendererUnavailable(error)) {
      throw error
    }
    throw new RuntimeClientError('renderer_unavailable', NO_APP_WINDOW_MESSAGE, {
      nextSteps: [
        'Open the file from the file explorer of an Orca app or mobile app connected to this server.',
        'To point a user at the file, give its path in your reply instead of opening a tab.'
      ]
    })
  }
}
