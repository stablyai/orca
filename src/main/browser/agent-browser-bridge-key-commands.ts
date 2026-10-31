import type { BrowserKeypressResult, BrowserTypeResult } from '../../shared/runtime-types'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { BrowserError } from './cdp-bridge'
import { acquireElectronDebugger } from './electron-debugger-lease'
import {
  parseCdpKeyEvent,
  imeFallbackKeyEvent,
  typedInputSteps,
  type TypedInputStep
} from './cdp-keyboard-us-layout'
import type { ResolvedBrowserCommandTarget } from './agent-browser-bridge-types'
import {
  dispatchPageKeyEvents,
  routePageTextInsertion,
  type GuestCdpSender
} from './guest-direct-key-input'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { AgentBrowserBridgeCaptureCommands } from './agent-browser-bridge-capture-commands'

// Bounds the events a typed run holds and how long it keeps the main loop busy.
const MAX_KEY_EVENTS_PER_RUN = 512

export abstract class AgentBrowserBridgeKeyCommands extends AgentBrowserBridgeCaptureCommands {
  async keypress(
    key: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserKeypressResult> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        const parsed = parseCdpKeyEvent(key) ?? imeFallbackKeyEvent(key)
        if (!parsed) {
          // Unknown keys need the helper; create its session only on this fallback path.
          await this.ensureSession(sessionName, target.browserPageId, target.webContentsId)
          return (await this.execAgentBrowser(sessionName, ['press', key])) as BrowserKeypressResult
        }
        await this.pressKeysInPage(sessionName, target, [parsed])
        return { pressed: key }
      },
      { ensureSession: false, requireScopedTarget: true }
    )
  }

  async type(
    input: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTypeResult> {
    await assertClipboardTextWriteWithinLimitWithYield(input)
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName, target) => {
        // The helper inserts printable text without key events, which key-driven editors ignore.
        await this.pressKeysInPage(sessionName, target, typedInputSteps(input))
        return { typed: true }
      },
      { ensureSession: false, requireScopedTarget: true }
    )
  }

  /** Sends each key as keydown and keyup to the page's focused element, as a person typing would. */
  protected async pressKeysInPage(
    sessionName: string,
    target: ResolvedBrowserCommandTarget,
    steps: Iterable<TypedInputStep>
  ): Promise<void> {
    const wc = this.requireTargetWebContents(target)
    let releaseDebugger = (): void => {}
    try {
      releaseDebugger = acquireElectronDebugger(wc).release
      await this.waitForPagePaint(wc, target.webContentsId)
      const send: GuestCdpSender = (method, params, sessionId) =>
        sendGuestCdpCommand(wc, method, params, sessionId)
      const guardFocus = (): Promise<() => void> =>
        this.browserManager.guardUserFocusForAgentInput(target.webContentsId)
      let run: Record<string, unknown>[] = []
      const flush = async (): Promise<void> => {
        if (run.length > 0) {
          await dispatchPageKeyEvents(wc, run, send, guardFocus)
          run = []
        }
      }
      for (const step of steps) {
        if (typeof step === 'string') {
          // Text no key types (emoji, controls) goes in like a paste, between the keys around it.
          await flush()
          const route = await routePageTextInsertion(wc, { text: step }, send, guardFocus)
          try {
            await route.deliver({ text: step })
          } finally {
            route.release()
          }
          continue
        }
        const event = {
          windowsVirtualKeyCode: step.keyCode,
          nativeVirtualKeyCode: step.keyCode,
          key: step.key,
          code: step.code,
          modifiers: step.modifiers,
          location: step.location
        }
        run.push(
          {
            // keyDown without text makes Blink synthesize empty input; use rawKeyDown for editing keys.
            type: step.text === null ? 'rawKeyDown' : 'keyDown',
            ...event,
            ...(step.text === null ? {} : { text: step.text, unmodifiedText: step.text })
          },
          // Blink clears a modifier's own bit on keyup.
          { type: 'keyUp', ...event, modifiers: step.modifiers & ~step.selfModifier }
        )
        // Tab and Enter can move focus into another frame; long lines yield to the main loop.
        if (step.key === 'Tab' || step.key === 'Enter' || run.length >= MAX_KEY_EVENTS_PER_RUN) {
          await flush()
        }
      }
      await flush()
    } catch (error) {
      // Browser error codes let the pane recognize and reclaim a dead page.
      if (error instanceof BrowserError) {
        throw error
      }
      if (!this.getWebContents(target.webContentsId)) {
        throw this.createPageUnavailableError(sessionName)
      }
      throw new BrowserError(
        'browser_error',
        `Failed to send keys to browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      releaseDebugger()
    }
  }
}
