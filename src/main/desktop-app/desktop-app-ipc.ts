import { BrowserWindow, ipcMain } from 'electron'
import type {
  DesktopAppAgentActivity,
  DesktopAppInputResult,
  DesktopAppWindow
} from '../../shared/desktop-app-types'
import { callComputerSidecarDesktopApp } from '../computer/sidecar-client'
import {
  allowDesktopAppAgent,
  blockDesktopAppAgent,
  isDesktopAppAgentBlocked,
  setDesktopAppActivityListener
} from './desktop-app-agent-control'
import { isTrustedUIRenderer } from '../ipc/ui'
import {
  isDesktopAppWindowAuthorized,
  prepareDesktopAppCapture,
  releaseDesktopAppCapture
} from './desktop-app-capture-source'
import {
  parseAgentBlockArgs,
  parsePidArgs,
  parseSendInputArgs,
  parseTargetArgs
} from './desktop-app-ipc-schema'
import { parseDesktopAppWindows, resolveListedTarget } from './desktop-app-window-list'

function broadcastAgentActivity(activity: DesktopAppAgentActivity): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send('desktopApp:agentActivity', activity)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

export function registerDesktopAppHandlers(): void {
  setDesktopAppActivityListener(broadcastAgentActivity)
  ipcMain.handle('desktopApp:listWindows', async (event): Promise<DesktopAppWindow[]> => {
    assertTrustedSender(event.sender)
    return await listWindows()
  })
  ipcMain.handle('desktopApp:prepareCapture', async (event, args: unknown) => {
    assertTrustedSender(event.sender)
    const requested = parseTargetArgs(args, 'desktopApp:prepareCapture')
    const target = resolveListedTarget(await listWindows(), requested)
    return await prepareDesktopAppCapture(event.sender, target)
  })
  ipcMain.handle('desktopApp:releaseCapture', (event, args: unknown) => {
    assertTrustedSender(event.sender)
    releaseDesktopAppCapture(event.sender, parseTargetArgs(args, 'desktopApp:releaseCapture'))
  })
  ipcMain.handle(
    'desktopApp:sendInput',
    async (event, args: unknown): Promise<DesktopAppInputResult> => {
      assertTrustedSender(event.sender)
      const { pid, windowId, input } = parseSendInputArgs(args, 'desktopApp:sendInput')
      // Why: input may only go to a window this renderer armed for capture, i.e. the one the
      // user picked in the pane, never an arbitrary app such as Terminal.
      if (!isDesktopAppWindowAuthorized(event.sender.id, { pid, windowId })) {
        throw new Error('desktopApp:sendInput: window was not chosen in this Desktop App tab')
      }
      const result = await callComputerSidecarDesktopApp('desktopInput', { pid, windowId, input })
      const path =
        result && typeof result === 'object' && 'path' in result ? result.path : undefined
      return { path: path === 'accessibility' ? 'accessibility' : 'synthetic' }
    }
  )
  ipcMain.handle('desktopApp:stopAgent', (event, args: unknown) => {
    assertTrustedSender(event.sender)
    blockDesktopAppAgent(parseAgentBlockArgs(args, 'desktopApp:stopAgent'))
  })
  ipcMain.handle('desktopApp:allowAgent', (event, args: unknown) => {
    assertTrustedSender(event.sender)
    allowDesktopAppAgent(parsePidArgs(args, 'desktopApp:allowAgent').pid)
  })
  ipcMain.handle('desktopApp:isAgentBlocked', (event, args: unknown) => {
    assertTrustedSender(event.sender)
    return isDesktopAppAgentBlocked(parsePidArgs(args, 'desktopApp:isAgentBlocked').pid)
  })
}

async function listWindows(): Promise<DesktopAppWindow[]> {
  return parseDesktopAppWindows(await callComputerSidecarDesktopApp('listDesktopWindows', {}))
}

function assertTrustedSender(sender: Electron.WebContents): void {
  if (!isTrustedUIRenderer(sender)) {
    throw new Error('desktopApp: untrusted sender')
  }
}
