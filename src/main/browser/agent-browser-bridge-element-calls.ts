import type { WebContents } from 'electron'
import { BrowserError } from './cdp-bridge'
import type { CapturedElement } from './cdp-element-capture'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { readRecord, readString } from './guest-frame-input-sessions'
import { AgentBrowserBridgeExecution } from './agent-browser-bridge-execution'

export type CapturedTarget = { wc: WebContents; captured: CapturedElement }

export abstract class AgentBrowserBridgeElementCalls extends AgentBrowserBridgeExecution {
  /** Runs a browser-element-functions action on the element the helper resolves, in its own frame. */
  protected async actOnElement(
    sessionName: string,
    element: string,
    action: string,
    functionDeclaration: string,
    args: unknown[] = []
  ): Promise<unknown> {
    const target = await this.captureElement(sessionName, element)
    return await this.callElementFunction(
      sessionName,
      target,
      element,
      action,
      functionDeclaration,
      {
        args
      }
    )
  }

  /** Resolves a ref or selector to the element the helper found, with the CDP session of its frame. */
  protected async captureElement(sessionName: string, element: string): Promise<CapturedTarget> {
    const session = this.sessions.get(sessionName)
    if (!session) {
      throw this.createPageUnavailableError(sessionName)
    }
    session.proxy.elementCapture.start()
    session.proxy.pointAtNextNode(true)
    let captured: CapturedElement | null
    try {
      // Any element read makes the helper resolve the ref or selector, in whichever frame owns it.
      await this.execAgentBrowser(sessionName, ['get', 'attr', element, 'id'])
    } finally {
      session.proxy.pointAtNextNode(false)
      captured = session.proxy.elementCapture.stop()
    }
    const wc = this.getWebContents(session.webContentsId)
    if (!wc) {
      throw this.createPageUnavailableError(sessionName)
    }
    if (!captured) {
      throw new BrowserError('browser_error', `Could not resolve ${element} in the page`)
    }
    return { wc, captured }
  }

  protected async callElementFunction(
    sessionName: string,
    { wc, captured }: CapturedTarget,
    element: string,
    action: string,
    functionDeclaration: string,
    { args = [], userGesture = false }: { args?: unknown[]; userGesture?: boolean } = {}
  ): Promise<unknown> {
    const response = await this.sendElementCdpCommand(
      sessionName,
      wc,
      'Runtime.callFunctionOn',
      {
        objectId: captured.objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        ...(userGesture ? { userGesture } : {})
      },
      captured.sessionId
    )
    const exception = readRecord(response, 'exceptionDetails')
    if (exception) {
      const description = readString(readRecord(exception, 'exception'), 'description')
      throw new BrowserError(
        'browser_eval_error',
        description ?? readString(exception, 'text') ?? 'Page function failed'
      )
    }
    const outcome = readRecord(response, 'result')?.value
    if (typeof outcome === 'string') {
      throw new BrowserError(
        'browser_element_not_interactable',
        `Cannot ${action} ${element}: ${outcome}`
      )
    }
    return outcome
  }

  protected sendElementCdpCommand(
    sessionName: string,
    wc: WebContents,
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<unknown> {
    return sendGuestCdpCommand(wc, method, params, sessionId).catch((error: unknown) => {
      if (error instanceof BrowserError) {
        throw error
      }
      const session = this.sessions.get(sessionName)
      if (!session || !this.getWebContents(session.webContentsId)) {
        throw this.createPageUnavailableError(sessionName)
      }
      throw new BrowserError(
        'browser_cdp_error',
        error instanceof Error ? error.message : String(error)
      )
    })
  }
}
