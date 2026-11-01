import type { RpcClient } from '../../transport/rpc-client'
import { sendMobileNativeChatMessageWithOutcome } from './mobile-native-chat-send'

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n')

export async function retryHeldHermesSubmit(args: {
  client: RpcClient
  terminal: string
  text: string
  deadline: number
  deviceToken: string | null
  isCurrent: () => boolean
}): Promise<void> {
  const expected = normalize(args.text)
  if (!expected) {
    return
  }
  const held = async (): Promise<boolean> => {
    const response = await args.client.sendRequest('terminal.read', {
      terminal: args.terminal,
      screen: true
    })
    if (
      !response.ok ||
      !response.result ||
      typeof response.result !== 'object' ||
      !('terminal' in response.result)
    ) {
      return false
    }
    const terminal = response.result.terminal
    return (
      !!terminal &&
      typeof terminal === 'object' &&
      'source' in terminal &&
      terminal.source === 'screen' &&
      'draft' in terminal &&
      typeof terminal.draft === 'string' &&
      normalize(terminal.draft) === expected
    )
  }
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    if (!args.isCurrent() || !(await held())) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    if (!args.isCurrent() || !(await held()) || !args.isCurrent()) {
      return
    }
    await sendMobileNativeChatMessageWithOutcome({
      client: args.client,
      terminal: args.terminal,
      text: '',
      enter: true,
      deadline: args.deadline,
      ...(args.deviceToken ? { mobileClient: { id: args.deviceToken, type: 'mobile' } } : {})
    })
  } catch {
    // A missing or stale screen never authorizes a second Enter.
  }
}
