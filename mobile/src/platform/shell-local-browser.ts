import type { ShellLocalBrowser } from './shell-local-browser-types'

/** In the native app the browser pane draws locally itself, so there is no shell to ask. */
export function useShellLocalBrowser(): ShellLocalBrowser {
  return { openFullScreen: null, placed: null }
}
