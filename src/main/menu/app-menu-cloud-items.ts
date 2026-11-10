import { BrowserWindow } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { getHostedSandboxControlPlaneClient } from '../hosted-sandbox/hosted-sandbox-install'

/** File › New cloud workspace, Orca Cloud builds only (spec D8). The ⇧⌘N chord itself is routed by
 * the shortcut policy, so the accelerator here is a hint only. */
export function createNewCloudWorkspaceMenuItems(): Electron.MenuItemConstructorOptions[] {
  if (getHostedSandboxControlPlaneClient() === null) {
    return []
  }
  return [
    {
      label: translateMain('menu.newCloudWorkspace', 'New cloud workspace'),
      accelerator: 'CmdOrCtrl+Shift+N',
      registerAccelerator: false,
      click: () => {
        BrowserWindow.getFocusedWindow()?.webContents.send('ui:openNewCloudWorkspace')
      }
    },
    { type: 'separator' }
  ]
}
