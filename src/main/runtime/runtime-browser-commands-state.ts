// @ts-nocheck -- mechanically split class members.
import type { ActiveBrowserScreencastPage } from './runtime-browser-commands-browser-command-target-params'

export class RuntimeBrowserCommandsState {
  protected readonly activeScreencastsByPageId = new Map<string, ActiveBrowserScreencastPage>()
}
