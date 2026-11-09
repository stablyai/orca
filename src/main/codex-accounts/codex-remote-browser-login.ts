import {
  signInCallbackPort,
  type HostAccountSignInChannel
} from '../../shared/host-account-sign-in-types'

/** Publishes codex's browser link with its localhost callback port for a remote person to forward. */
export function publishCodexCallbackPrompt(channel: HostAccountSignInChannel, url: string): void {
  const callbackPort = signInCallbackPort(url)
  channel.onPrompt({
    url,
    userCode: null,
    needsCode: false,
    ...(callbackPort === null ? {} : { callbackPort })
  })
}

/** The page opens on the remote person's device. Linux honors BROWSER, so `true` keeps codex from
 *  opening one here; macOS hosts have no such switch and may also open the page locally. */
export function withoutHostBrowser(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.platform === 'linux' ? { ...env, BROWSER: 'true' } : env
}
