import type { WebContents } from 'electron'
import { mobileTouchClickExpression, readClickPoint } from './cdp-pointer-targets'
import {
  readRecord,
  sendFrameSessionInput,
  settle,
  type GuestSessionCdpSender
} from './guest-frame-input-sessions'
import { resolveCrossSitePointerTarget } from './offscreen-frame-pointer-route'

/** Activates touch targets inside cross-site iframes (e.g. Google Sign-In) under mobile emulation. */
export async function resolveCrossSiteMobileTouchClick(
  webContents: WebContents,
  x: number,
  y: number,
  radius: number | undefined,
  allowDomActivation: boolean
): Promise<{ x: number; y: number; adjusted: boolean; handled: boolean } | null> {
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) {
    return null
  }
  const sendRaw: GuestSessionCdpSender = (method, params, sessionId) =>
    Promise.resolve(
      sessionId === undefined
        ? webContents.debugger.sendCommand(method, params)
        : webContents.debugger.sendCommand(method, params, sessionId)
    )
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
    handled: parsed.handled
  }
}
