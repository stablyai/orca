import type { WebContents } from 'electron'
import { createGuestRawCdpSender } from '../debugger/guest-cdp-command'
import { assertExpectedPageUrlForStep } from './browser-expected-page-url'
import { mobileTouchClickExpression, readClickPoint } from './cdp-pointer-targets'
import {
  readRecord,
  sendFrameSessionInput,
  settle,
  type GuestSessionCdpSender
} from './guest-frame-input-sessions'
import { resolveCrossSitePointerTarget } from './offscreen-frame-pointer-route'
import { assertRemoteCliPageAccess } from '../../routing/input-ownership/remote-cli-page-admission'

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
  // Recheck admission and expected URL immediately before activation (after focus emulation awaits).
  let guardError: unknown = null
  const sendGuarded: GuestSessionCdpSender = (method, params, sessionId) => {
    if (method === 'Runtime.evaluate') {
      try {
        assertRemoteCliPageAccess(webContents.id)
        assertExpectedPageUrlForStep()
      } catch (error) {
        guardError = error
        return Promise.reject(error)
      }
    }
    return sendRaw(method, params, sessionId)
  }
  const evaluated = await settle(
    sendFrameSessionInput(webContents, sendGuarded, target.sessionId, 'Runtime.evaluate', {
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
  if (guardError !== null) {
    throw guardError
  }
  if (evaluated.outcome === 'timeout') {
    // An activating evaluate is already in flight and cannot be cancelled; avoid a duplicate fallback click.
    return {
      x,
      y,
      adjusted: false,
      handled: allowDomActivation,
      frameSessionId: target.sessionId,
      framePoint: target.framePoint
    }
  }
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
