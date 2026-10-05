import type { WebContents } from 'electron'
import { z } from 'zod'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { runDebuggerCommandWithTimeout } from './browser-screencast-debugger-command'
export type OwnedCaptureViewport = {
  devicePixelRatio: number
  height: number
  scrollX: number
  scrollY: number
  timeOrigin: number
  width: number
}

const dimensionSchema = z
  .number()
  .int()
  .positive()
  .max(2 ** 31 - 1)
const viewportSchema = z.object({
  innerWidth: dimensionSchema,
  innerHeight: dimensionSchema,
  devicePixelRatio: z.number().finite().positive(),
  scrollX: z.number().finite(),
  scrollY: z.number().finite(),
  timeOrigin: z.number().finite().positive()
})
const evaluationSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.unknown().optional()
})
const viewportExpression = `({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY,
  timeOrigin: performance.timeOrigin
})`

export async function readOwnedCaptureViewportState(
  guest: WebContents
): Promise<OwnedCaptureViewport> {
  const response = evaluationSchema.parse(
    await runDebuggerCommandWithTimeout('Runtime.evaluate', () =>
      sendGuestCdpCommand(guest, 'Runtime.evaluate', {
        expression: viewportExpression,
        returnByValue: true
      })
    )
  )
  if (response.exceptionDetails !== undefined) {
    throw new Error('Unable to read owned browser capture viewport')
  }
  const viewport = viewportSchema.parse(response.result.value)
  return {
    width: viewport.innerWidth,
    height: viewport.innerHeight,
    devicePixelRatio: viewport.devicePixelRatio,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    timeOrigin: viewport.timeOrigin
  }
}

async function scrollOwnedCaptureViewport(
  guest: WebContents,
  original: OwnedCaptureViewport
): Promise<void> {
  const { scrollX: x, scrollY: y, timeOrigin } = original
  const response = evaluationSchema.parse(
    await runDebuggerCommandWithTimeout('Runtime.evaluate', () =>
      sendGuestCdpCommand(guest, 'Runtime.evaluate', {
        expression: `if (performance.timeOrigin !== ${timeOrigin}) throw new Error('Browser document changed'); window.scrollTo({left:${x},top:${y},behavior:'instant'}); true`,
        returnByValue: true
      })
    )
  )
  if (response.exceptionDetails !== undefined) {
    throw new Error('Unable to restore owned browser capture scroll position')
  }
}

export async function waitForOwnedCaptureViewport(
  guest: WebContents,
  verify: (viewport: OwnedCaptureViewport) => void
): Promise<OwnedCaptureViewport> {
  for (let attempt = 0; ; attempt += 1) {
    const viewport = await readOwnedCaptureViewportState(guest)
    try {
      verify(viewport)
      return viewport
    } catch (error) {
      if (attempt >= 19) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function restoreOwnedCaptureViewport(
  guest: WebContents,
  original: OwnedCaptureViewport
): Promise<void> {
  const verifySize = (viewport: OwnedCaptureViewport): void => {
    if (viewport.timeOrigin !== original.timeOrigin) {
      throw new Error('Owned browser page navigated during capture')
    }
    if (
      viewport.width !== original.width ||
      viewport.height !== original.height ||
      viewport.devicePixelRatio !== original.devicePixelRatio
    ) {
      throw new Error('Owned browser capture did not restore the original viewport')
    }
  }
  await waitForOwnedCaptureViewport(guest, verifySize)
  await scrollOwnedCaptureViewport(guest, original)
  await waitForOwnedCaptureViewport(guest, (viewport) => {
    verifySize(viewport)
    if (
      Math.abs(viewport.scrollX - original.scrollX) > 1 ||
      Math.abs(viewport.scrollY - original.scrollY) > 1
    ) {
      throw new Error('Owned browser capture did not restore the original scroll position')
    }
  })
}

/** Changes only the guest frame size, leaving device metrics and native container geometry intact. */
export async function resizeOwnedCaptureFrame(
  guest: WebContents,
  size: { width: number; height: number }
): Promise<void> {
  await runDebuggerCommandWithTimeout('Emulation.setVisibleSize', () =>
    sendGuestCdpCommand(guest, 'Emulation.setVisibleSize', size)
  )
}
