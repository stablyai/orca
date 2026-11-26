import type { WebContents } from 'electron'
import { createGuestRawCdpSender } from '../debugger/guest-cdp-command'
import { mobileTouchClickExpression, readClickPoint } from './cdp-pointer-targets'
import { readRecord, sendFrameSessionInput, settle } from './guest-frame-input-sessions'
import { resolveCrossSitePointerTarget } from './offscreen-frame-pointer-route'

export type ResolvedCrossSiteTouchClick = {
  x: number
  y: number
  adjusted: boolean
  handled: boolean
  frameSessionId: string
  framePoint: { x: number; y: number }
}

/** Activates touch targets inside cross-site iframes (e.g. Google Sign-In) under mobile emulation. */
export async function resolveCrossSiteMobileTouchClick(
  webContents: WebContents,
  x: number,
  y: number,
  radius: number | undefined,
  allowDomActivation: boolean
): Promise<ResolvedCrossSiteTouchClick | null> {
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return null
  }
  const sendRaw = createGuestRawCdpSender(webContents)
  const target = await resolveCrossSitePointerTarget(webContents, sendRaw, { x, y })
  if (!target) {
    return null
  }
  const evaluated = await settle(
    sendFrameSessionInput(webContents, sendRaw, target.sessionId, 'Runtime.evaluate', {
      expression: mobileTouchClickExpression(
        target.framePoint.x,
        target.framePoint.y,
        radius,
        allowDomActivation
      ),
      userGesture: true,
      returnByValue: true,
      silent: true
    })
  )
  if (evaluated.outcome !== 'ok') {
    return null
  }
  const resultRecord = readRecord(evaluated.value, 'result')
  const parsed = readClickPoint(resultRecord?.value, {
    x: target.framePoint.x,
    y: target.framePoint.y,
    adjusted: false,
    handled: false
  })
  return {
    x: x + (parsed.x - target.framePoint.x),
    y: y + (parsed.y - target.framePoint.y),
    adjusted: parsed.adjusted,
    handled: parsed.handled,
    frameSessionId: target.sessionId,
    framePoint: { x: parsed.x, y: parsed.y }
  }
}
