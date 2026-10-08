import { ipcMain } from 'electron'
import type {
  DesktopBrowserViewCapture,
  DesktopBrowserViewCommandArgs,
  DesktopBrowserViewCommandResult,
  DesktopBrowserViewCreateArgs,
  DesktopBrowserViewIdentity,
  DesktopBrowserViewInputArgs,
  DesktopBrowserViewLayout,
  DesktopBrowserViewState
} from '../../shared/desktop-browser-view-protocol'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import {
  desktopBrowserViewCommandSchema,
  desktopBrowserViewCreateSchema,
  desktopBrowserViewIdentitySchema,
  desktopBrowserViewInputSchema,
  desktopBrowserViewLayoutSchema
} from './desktop-browser-view-request'

export type DesktopBrowserViewPageService = {
  create: (
    sender: Electron.WebContents,
    args: DesktopBrowserViewCreateArgs
  ) => Promise<DesktopBrowserViewState>
  updateLayout: (sender: Electron.WebContents, args: DesktopBrowserViewLayout) => Promise<void>
  command: (
    sender: Electron.WebContents,
    args: DesktopBrowserViewCommandArgs
  ) => Promise<DesktopBrowserViewCommandResult>
  close: (sender: Electron.WebContents, args: DesktopBrowserViewIdentity) => Promise<void>
  input: (sender: Electron.WebContents, args: DesktopBrowserViewInputArgs) => Promise<void>
  captureViewport: (
    sender: Electron.WebContents,
    args: DesktopBrowserViewIdentity
  ) => Promise<DesktopBrowserViewCapture>
}

function requireDesktopRenderer(event: Electron.IpcMainInvokeEvent): Electron.WebContents {
  if (!isTrustedBrowserRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Desktop browser view requires the trusted main renderer frame')
  }
  return event.sender
}

export function registerDesktopBrowserViewHandlers(service: DesktopBrowserViewPageService): void {
  const channels = {
    create: 'browser:desktop-view:create',
    layout: 'browser:desktop-view:layout',
    command: 'browser:desktop-view:command',
    input: 'browser:desktop-view:input',
    captureViewport: 'browser:desktop-view:capture-viewport',
    close: 'browser:desktop-view:close'
  }
  for (const channel of Object.values(channels)) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle(channels.create, (event, args: unknown) =>
    service.create(requireDesktopRenderer(event), desktopBrowserViewCreateSchema.parse(args))
  )
  ipcMain.handle(channels.layout, (event, args: unknown) =>
    service.updateLayout(requireDesktopRenderer(event), desktopBrowserViewLayoutSchema.parse(args))
  )
  ipcMain.handle(channels.command, (event, args: unknown) =>
    service.command(requireDesktopRenderer(event), desktopBrowserViewCommandSchema.parse(args))
  )
  ipcMain.handle(channels.input, (event, args: unknown) =>
    service.input(requireDesktopRenderer(event), desktopBrowserViewInputSchema.parse(args))
  )
  ipcMain.handle(channels.close, (event, args: unknown) =>
    service.close(requireDesktopRenderer(event), desktopBrowserViewIdentitySchema.parse(args))
  )
  ipcMain.handle(channels.captureViewport, (event, args: unknown) =>
    service.captureViewport(
      requireDesktopRenderer(event),
      desktopBrowserViewIdentitySchema.parse(args)
    )
  )
}
