import type { HostAccountSignInChannel } from '../../shared/agent-accounts/host-account-sign-in-types'
import type { runCodexLoginSession } from './login/codex-login-session'
import { publishCodexCallbackPrompt } from './codex-remote-browser-login'

type CodexLoginChannelOptions = Pick<
  Parameters<typeof runCodexLoginSession>[1],
  'onAuthUrl' | 'deviceAuth' | 'remoteBrowser'
>

/**
 * Where a Codex login's sign-in link goes: a remote person's browser callback (the link is theirs,
 * so this host's Orca windows don't offer it), a device-code prompt, or this host's own windows.
 */
export function codexLoginChannelOptions(
  channel: HostAccountSignInChannel | undefined,
  setPendingLoginUrl: (url: string) => void
): CodexLoginChannelOptions {
  if (!channel) {
    return { onAuthUrl: setPendingLoginUrl }
  }
  if (channel.callback) {
    return {
      onAuthUrl: (url: string) => publishCodexCallbackPrompt(channel, url),
      remoteBrowser: true
    }
  }
  return {
    onAuthUrl: setPendingLoginUrl,
    deviceAuth: {
      onPrompt: ({ url, userCode }: { url: string; userCode: string }) =>
        channel.onPrompt({ url, userCode, needsCode: false })
    }
  }
}
