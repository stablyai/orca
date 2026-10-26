import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime-client'
import { callConnector } from './connector'

type CloudLink = { hostId: string; email: string; hostName: string; linkedAt: number }
type CloudStatus = { enabled: boolean; link: CloudLink | null }
type CloudSignInPrompt = {
  flowId: string
  userCode: string
  verificationUri: string
  expiresAt: number
}

// The approval page waits a little past the code's expiry for the host's last poll.
const FINISH_SIGN_IN_GRACE_MS = 30_000

async function callCloud<TResult>(
  { client, flags }: Pick<HandlerContext, 'client' | 'flags'>,
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs: number }
) {
  rejectRemoteSelectionFlags(flags, '`orca cloud`. Run it on the Orca host you want to connect.')
  try {
    return await callConnector<TResult>(client, method, params, options)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'connectors_disabled') {
      throw new RuntimeClientError('connectors_disabled', 'Connectors are off on this Orca.')
    }
    throw error
  }
}

export function formatCloudLink(link: CloudLink): string {
  return `Connected as ${link.email} on ${link.hostName}`
}

export function formatCloudStatus(status: CloudStatus): string {
  return [
    status.link ? formatCloudLink(status.link) : 'Signed out',
    ...(status.enabled ? [] : ['Connectors are off on this Orca.'])
  ].join('\n')
}

export function formatSignInPrompt(prompt: CloudSignInPrompt, now: number): string {
  const minutes = Math.max(1, Math.round((prompt.expiresAt - now) / 60_000))
  return `To connect this Orca, open ${prompt.verificationUri} and enter ${prompt.userCode} (expires in ${minutes} minutes)`
}

export const CLOUD_HANDLERS: Record<string, CommandHandler> = {
  'cloud login': async (context) => {
    const name = getOptionalStringFlag(context.flags, 'name')
    const { result: prompt } = await callCloud<CloudSignInPrompt>(
      context,
      'cloud.beginSignIn',
      name ? { name } : {}
    )
    // --json keeps stdout for the result; the person still needs the code.
    const write = context.json ? console.error : console.log
    write(formatSignInPrompt(prompt, Date.now()))
    // Ctrl+C closes the connection, which cancels the sign-in on the host.
    const result = await callCloud<CloudLink>(
      context,
      'cloud.finishSignIn',
      { flowId: prompt.flowId },
      { timeoutMs: Math.max(0, prompt.expiresAt - Date.now()) + FINISH_SIGN_IN_GRACE_MS }
    )
    printResult(result, context.json, formatCloudLink)
  },
  'cloud logout': async (context) => {
    const result = await callCloud<{ signedOut: boolean }>(context, 'cloud.signOut', {})
    printResult(result, context.json, (value) =>
      value.signedOut ? 'Signed out' : 'Already signed out'
    )
  },
  'cloud status': async (context) => {
    const result = await callCloud<CloudStatus>(context, 'cloud.status', {})
    printResult(result, context.json, formatCloudStatus)
  }
}
