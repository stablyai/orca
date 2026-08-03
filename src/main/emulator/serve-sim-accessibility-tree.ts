import { net } from 'electron'
import { EmulatorError } from './emulator-errors'
import { normalizeServeSimAxTree, type NormalizedAxNode } from './serve-sim-ax-normalization'

const AX_REQUEST_TIMEOUT_MS = 5_000
const MAX_ERROR_BODY_LENGTH = 512

export async function requestServeSimAccessibilityTree(axUrl: string): Promise<NormalizedAxNode[]> {
  try {
    const response = await net.fetch(axUrl, {
      signal: AbortSignal.timeout(AX_REQUEST_TIMEOUT_MS)
    })
    const body = await response.text()
    if (!response.ok) {
      const detail = body.slice(0, MAX_ERROR_BODY_LENGTH) || response.statusText
      const retry = response.status === 503 ? ' Accessibility may still be warming up; retry.' : ''
      throw new EmulatorError(
        'emulator_helper_failed',
        `serve-sim AX request failed (${response.status}): ${detail}.${retry}`
      )
    }

    let tree: unknown
    try {
      tree = JSON.parse(body)
    } catch {
      throw new EmulatorError('emulator_error', 'serve-sim AX returned invalid JSON.')
    }
    if (
      !Array.isArray(tree) ||
      tree.some((node) => typeof node !== 'object' || node === null || Array.isArray(node))
    ) {
      throw new EmulatorError('emulator_error', 'serve-sim AX returned an invalid tree.')
    }
    // serve-sim reports frames in absolute pixels; normalize to 0..1 so the
    // output feeds straight back into tap/gesture.
    return normalizeServeSimAxTree(tree)
  } catch (error) {
    if (error instanceof EmulatorError) {
      throw error
    }
    const detail =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'request timed out'
        : error instanceof Error
          ? error.message
          : 'unknown request failure'
    throw new EmulatorError('emulator_helper_failed', `Unable to read serve-sim AX: ${detail}`)
  }
}
