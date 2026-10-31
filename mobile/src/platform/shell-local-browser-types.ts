import type {
  BridgeBrowserLocalParams,
  BridgeBrowserViewEnding,
  BridgeBrowserViewFrame,
  BridgeBrowserViewShowParams
} from '../mobile-web-shell/bridge/bridge-native-verbs'

// What a served page can ask the app shell to draw for a browser tab; null when the installed app cannot.
export type ShellLocalBrowser = {
  openFullScreen: ((params: BridgeBrowserLocalParams) => Promise<void>) | null
  // A native web view the shell places over the page's pane.
  placed: {
    show: (params: BridgeBrowserViewShowParams) => Promise<BridgeBrowserViewEnding>
    move: (id: string, frame: BridgeBrowserViewFrame) => Promise<void>
    remove: (id: string) => Promise<void>
  } | null
}
