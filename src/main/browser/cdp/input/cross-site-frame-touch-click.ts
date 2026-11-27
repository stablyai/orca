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
  // Step 1: non-activating hit-test so a timeout or non-matching target (e.g. canvas) safely falls back to CDP.
  const probed = await settle(
    sendFrameSessionInput(webContents, sendRaw, target.sessionId, 'Runtime.evaluate', {
      expression: mobileTouchClickExpression(
        target.framePoint.x,
        target.framePoint.y,
        radius,
        false
      ),
      userGesture: false,
      returnByValue: true,
      silent: true
    })
  )
  if (probed.outcome !== 'ok') {
    return {
      x,
      y,
      adjusted: false,
      handled: false,
      frameSessionId: target.sessionId,
      framePoint: target.framePoint
    }
  }
  const probeRecord = readRecord(probed.value, 'result')
  const parsed = readClickPoint(probeRecord?.value, {
    x: target.framePoint.x,
    y: target.framePoint.y,
    adjusted: false,
    handled: false
  })
  if (!allowDomActivation || !parsed.adjusted) {
    return {
      x: x + (parsed.x - target.framePoint.x),
      y: y + (parsed.y - target.framePoint.y),
      adjusted: parsed.adjusted,
      handled: false,
      frameSessionId: target.sessionId,
      framePoint: { x: parsed.x, y: parsed.y }
    }
  }
  // Step 2: clickable target confirmed; recheck admission and expected URL immediately before activation.
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
  const activated = await settle(
    sendFrameSessionInput(webContents, sendGuarded, target.sessionId, 'Runtime.evaluate', {
      expression: mobileTouchClickExpression(parsed.x, parsed.y, radius, true),
      userGesture: true,
      returnByValue: true,
      silent: true
    })
  )
  if (guardError !== null) {
    throw guardError
  }
  if (activated.outcome === 'timeout') {
    // Activation was started for a confirmed target and cannot be cancelled; avoid a duplicate fallback click.
    return {
      x: x + (parsed.x - target.framePoint.x),
      y: y + (parsed.y - target.framePoint.y),
      adjusted: true,
      handled: true,
      frameSessionId: target.sessionId,
      framePoint: { x: parsed.x, y: parsed.y }
    }
  }
  if (activated.outcome !== 'ok') {
    return null
  }
  const resultRecord = readRecord(activated.value, 'result')
  const activatedPoint = readClickPoint(resultRecord?.value, {
    x: parsed.x,
    y: parsed.y,
    adjusted: true,
    handled: false
  })
  return {
    x: x + (activatedPoint.x - target.framePoint.x),
    y: y + (activatedPoint.y - target.framePoint.y),
    adjusted: activatedPoint.adjusted,
    handled: activatedPoint.handled,
    frameSessionId: target.sessionId,
    framePoint: { x: activatedPoint.x, y: activatedPoint.y }
  }
}
