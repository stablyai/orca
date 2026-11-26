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
import {
  installElectronHeavyWorkerHost,
  installElectronJournalReaderHost
} from './electron-utility-worker-hosts'

export function installElectronNativeServices(): void {
  // Bind PTY IPC/power at process scope: headless serve has no window yet and must not register no-op handlers.
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  // Node hosts omit desktop surfaces and route notifications to paired clients instead.
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  // Install Chromium browser commands only in Electron; Node hosts advertise no browser capability and reject those RPCs.
  installElectronBrowserCommands()
  // Electron consults default-session proxy config; Node hosts use environment only.
  setDefaultProxySessionResolver(() => session.defaultSession)
  // Desktop integrations use Chromium networking; Node differs in proxy environment and user agent.
  setMainHttpClient(electronHttpClient)
  // Only Electron supplies streaming speech services; other hosts reject speech calls.
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
  installElectronJournalReaderHost()
  installElectronHeavyWorkerHost()
}
