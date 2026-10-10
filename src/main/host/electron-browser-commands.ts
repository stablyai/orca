import { RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'

/** The desktop factory. Importing this file is what pulls in the Chromium browser cluster. */
export function installElectronBrowserCommands(): void {
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
    clientHosting: true
  })
}
