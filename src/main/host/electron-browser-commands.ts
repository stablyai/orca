import { RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'
import type { RuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'

/** The desktop factory. Importing this file is what pulls in the Chromium browser cluster. */
export const electronRuntimeBrowserCommandsFactory: RuntimeBrowserCommandsFactory = (host) =>
  new RuntimeBrowserCommands(host)
