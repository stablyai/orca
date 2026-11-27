import type { WebContents } from 'electron'
import { sendGuestCdpCommand } from '../../cdp/debugger/guest-cdp-command'

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Input points are in the page's CSS px; innerWidth/innerHeight include classic scrollbars,
// matching the webview box the renderer scales against, where clientWidth would not.
export async function readPageViewport(
  guest: WebContents
): Promise<{ width: number; height: number } | null> {
  try {
    const response: unknown = await sendGuestCdpCommand(guest, 'Runtime.evaluate', {
      expression: '[innerWidth, innerHeight]',
      returnByValue: true
    })
    const result =
      response !== null && typeof response === 'object' && 'result' in response
        ? response.result
        : null
    const size =
      result !== null && typeof result === 'object' && 'value' in result ? result.value : null
    if (Array.isArray(size) && isPositiveNumber(size[0]) && isPositiveNumber(size[1])) {
      return { width: size[0], height: size[1] }
    }
  } catch {
    // A page that cannot report its viewport just shows no cursor.
  }
  return null
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}
