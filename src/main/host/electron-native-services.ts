import { ipcMain, powerMonitor, session } from 'electron'
import { setPtyHostBindings } from '../ipc/pty/pty-host-bindings'
import { electronRuntimeDesktopSurface } from './electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'
import { installElectronBrowserCommands } from './electron-browser-commands'
import { electronHttpClient } from './electron-http-client'
import { setMainHttpClient } from '../network/http-client'
import { electronSpeechServiceFactories } from './electron-speech-services'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from '../workspaces/removal/worktree-watcher-removal'
import { desktopWorktreeWatcherRemoval } from '../ipc/filesystem/watchers/filesystem-watcher'
import { setDefaultProxySessionResolver } from '../network/electron-default-proxy-session'

export function installElectronNativeServices(): void {
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  installElectronBrowserCommands()
  setDefaultProxySessionResolver(() => session.defaultSession)
  setMainHttpClient(electronHttpClient)
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
}
