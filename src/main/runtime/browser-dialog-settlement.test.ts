/**
 * Where `browser.dialogAccept` and `browser.dialogDismiss` send their answer.
 *
 * The answer has to reach the CDP session that reported the dialog. The agent-browser path cannot
 * be that session: it runs a fresh client whose bootstrap is renderer-bound, and a page sitting in
 * a modal dialog answers no renderer-bound command until the dialog is gone. So with a stream live
 * on the page, the stream settles it; with no stream, nothing changes.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  webContents: { fromId: () => ({ isDestroyed: () => false }) }
}))

import { RuntimeBrowserCommandsWithBrowserSetHeaders } from './runtime-browser-commands-browser-set-headers'
import type { ActiveBrowserScreencastPage } from './runtime-browser-commands-browser-command-target-params'
import type { BrowserScreencastSession } from '../browser/browser-screencast-stream-types'

const PAGE_ID = 'page-1'

class DialogCommandsUnderTest extends RuntimeBrowserCommandsWithBrowserSetHeaders {
  registerLiveScreencast(browserPageId: string, record: ActiveBrowserScreencastPage): void {
    this.activeScreencastsByPageId.set(browserPageId, record)
  }
}

function streamingPage(session: BrowserScreencastSession): ActiveBrowserScreencastPage {
  return {
    format: 'jpeg',
    session,
    started: Promise.resolve(session),
    stopping: false,
    subscribers: new Map(),
    viewportOwnerSubscriptionId: null,
    appliedBudget: {
      quality: 72,
      maxWidth: 768,
      maxHeight: 1133,
      everyNthFrame: 1,
      minFrameIntervalMs: 100
    }
  }
}

function createCommands(settleDialog: (accept: boolean, promptText?: string) => Promise<boolean>) {
  const bridge = {
    getRegisteredTabs: () => new Map([[PAGE_ID, 7]]),
    dialogAccept: vi.fn(async () => ({ via: 'bridge' })),
    dialogDismiss: vi.fn(async () => ({ via: 'bridge' }))
  }
  const host = { getAgentBrowserBridge: () => bridge }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog path reads only getAgentBrowserBridge off the host.
  const commands = new DialogCommandsUnderTest(host as never)
  const registerStream = (): void => {
    commands.registerLiveScreencast(
      PAGE_ID,
      streamingPage({
        stop: () => {},
        done: Promise.resolve(),
        updateViewport: async () => {},
        updateFrameBudget: async () => {},
        settleDialog
      })
    )
  }
  return { bridge, commands, registerStream }
}

describe('a dialog reply goes to the stream that reported it', () => {
  it('accepts through the live stream instead of the agent-browser bridge', async () => {
    const settleDialog = vi.fn(async () => true)
    const { bridge, commands, registerStream } = createCommands(settleDialog)
    registerStream()

    const result = await commands.browserDialogAccept({ page: PAGE_ID, text: 'Ada' })

    expect(settleDialog).toHaveBeenCalledWith(true, 'Ada')
    expect(bridge.dialogAccept).not.toHaveBeenCalled()
    expect(result).toEqual({ accepted: true })
  })

  it('dismisses through the live stream instead of the agent-browser bridge', async () => {
    const settleDialog = vi.fn(async () => true)
    const { bridge, commands, registerStream } = createCommands(settleDialog)
    registerStream()

    const result = await commands.browserDialogDismiss({ page: PAGE_ID })

    expect(settleDialog).toHaveBeenCalledWith(false, undefined)
    expect(bridge.dialogDismiss).not.toHaveBeenCalled()
    expect(result).toEqual({ accepted: false })
  })

  it('falls back to the bridge when the stream has no dialog open', async () => {
    const settleDialog = vi.fn(async () => false)
    const { bridge, commands, registerStream } = createCommands(settleDialog)
    registerStream()

    await commands.browserDialogAccept({ page: PAGE_ID })

    expect(settleDialog).toHaveBeenCalledWith(true, undefined)
    expect(bridge.dialogAccept).toHaveBeenCalledTimes(1)
  })

  it('falls back to the bridge when no stream is live on the page', async () => {
    const settleDialog = vi.fn(async () => true)
    const { bridge, commands } = createCommands(settleDialog)

    await commands.browserDialogDismiss({ page: PAGE_ID })

    expect(settleDialog).not.toHaveBeenCalled()
    expect(bridge.dialogDismiss).toHaveBeenCalledTimes(1)
  })

  it('answers one shape whichever path ran, so a viewer cannot change the reply', async () => {
    const streamed = createCommands(vi.fn(async () => true))
    streamed.registerStream()
    const bridged = createCommands(vi.fn(async () => false))
    bridged.registerStream()

    expect(await streamed.commands.browserDialogAccept({ page: PAGE_ID })).toEqual(
      await bridged.commands.browserDialogAccept({ page: PAGE_ID })
    )
    expect(await streamed.commands.browserDialogDismiss({ page: PAGE_ID })).toEqual(
      await bridged.commands.browserDialogDismiss({ page: PAGE_ID })
    )
    // The bridge answered on the second of each pair, so the bodies above came from both paths.
    expect(bridged.bridge.dialogAccept).toHaveBeenCalledTimes(1)
    expect(bridged.bridge.dialogDismiss).toHaveBeenCalledTimes(1)
    expect(streamed.bridge.dialogAccept).not.toHaveBeenCalled()
  })
})
