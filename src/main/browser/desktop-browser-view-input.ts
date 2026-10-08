import type { WebContents } from 'electron'
import { z } from 'zod'

import {
  DesktopBrowserViewInputSchema,
  type DesktopBrowserViewInput
} from '../../shared/desktop-browser-view-input'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { resolveKeyDefinition } from './cdp-text-input-commands'

const layoutMetrics = z.object({
  cssVisualViewport: z.object({
    clientWidth: z.number().finite().positive(),
    clientHeight: z.number().finite().positive()
  })
})

function modifierMask(values: readonly string[]): number {
  return values.reduce(
    (mask, value) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[value] ?? 0),
    0
  )
}

function cssViewport(metrics: unknown): { width: number; height: number } {
  const parsed = layoutMetrics.safeParse(metrics)
  if (!parsed.success) {
    throw new Error('Browser CSS visual viewport is unavailable')
  }
  return {
    width: parsed.data.cssVisualViewport.clientWidth,
    height: parsed.data.cssVisualViewport.clientHeight
  }
}

export async function dispatchDesktopBrowserViewInput(
  webContents: WebContents,
  value: unknown
): Promise<void> {
  const input: DesktopBrowserViewInput = DesktopBrowserViewInputSchema.parse(value)
  if (webContents.isDestroyed()) {
    throw new Error('Browser tab is no longer available')
  }
  const lease = acquireElectronDebugger(webContents)
  try {
    if (input.kind === 'mouse') {
      const viewport = cssViewport(await sendGuestCdpCommand(webContents, 'Page.getLayoutMetrics'))
      const type =
        input.type === 'move'
          ? 'mouseMoved'
          : input.type === 'down'
            ? 'mousePressed'
            : input.type === 'up'
              ? 'mouseReleased'
              : 'mouseWheel'
      await sendGuestCdpCommand(webContents, 'Input.dispatchMouseEvent', {
        type,
        x: input.x * viewport.width,
        y: input.y * viewport.height,
        button: input.type === 'wheel' ? 'none' : input.button,
        buttons: input.buttons,
        modifiers: modifierMask(input.modifiers),
        clickCount: input.type === 'down' || input.type === 'up' ? 1 : undefined,
        deltaX: input.type === 'wheel' ? input.deltaX : undefined,
        deltaY: input.type === 'wheel' ? input.deltaY : undefined
      })
    } else if (input.kind === 'key') {
      const definition = resolveKeyDefinition(input.key)
      const shortcut = input.modifiers.some((modifier) => modifier !== 'Shift')
      await sendGuestCdpCommand(webContents, 'Input.dispatchKeyEvent', {
        type: input.type === 'down' ? 'keyDown' : 'keyUp',
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
        text: input.type === 'down' && !shortcut ? (input.text ?? definition.text) : undefined,
        modifiers: modifierMask(input.modifiers)
      })
    } else {
      // Composition is explicitly committed text: IME preedit/candidate updates are not represented by this contract.
      await sendGuestCdpCommand(webContents, 'Input.insertText', { text: input.text })
    }
  } finally {
    lease.release()
  }
}
