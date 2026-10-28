/** Modal replies must use the reporting CDP session; a fresh renderer-bound client blocks behind the dialog. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  webContents: { fromId: () => ({ isDestroyed: () => false }) }
}))

import { RuntimeBrowserDialogs } from './browser/browser-dialogs'
import { settleBrowserDialogOnLiveScreencast } from './browser-dialog-settlement'
import type { ActiveBrowserScreencastPage } from './browser/browser-screencast-contracts'
import type { BrowserScreencastSession } from '../browser/browser-screencast-stream-types'

const PAGE_ID = 'page-1'

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
  const activeScreencastsByPageId = new Map<string, ActiveBrowserScreencastPage>()
  const commands = new RuntimeBrowserDialogs(
    {
      resolveBrowserCommandTarget: async (params) => ({ browserPageId: params.page }),
      requireAgentBrowserBridge: () => bridge
    },
    {
      settleDialog: (pageId, accept, promptText) =>
        settleBrowserDialogOnLiveScreencast(activeScreencastsByPageId, pageId, accept, promptText)
    }
  )
  const registerStream = (): void => {
    activeScreencastsByPageId.set(
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
    expect(bridged.bridge.dialogAccept).toHaveBeenCalledTimes(1)
    expect(bridged.bridge.dialogDismiss).toHaveBeenCalledTimes(1)
    expect(streamed.bridge.dialogAccept).not.toHaveBeenCalled()
  })
})
