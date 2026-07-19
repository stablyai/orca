import type { RpcClient } from '../transport/rpc-client'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'

type MobileTerminalClient = {
  id: string
  type: 'mobile'
}

export async function sendMobileNativeChatMessage(args: {
  client: RpcClient
  terminal: string
  text: string
  enter?: boolean
  mobileClient?: MobileTerminalClient
}): Promise<boolean> {
  try {
    const response = await args.client.sendRequest('terminal.send', {
      terminal: args.terminal,
      text: args.text,
      enter: args.enter ?? true,
      ...(args.mobileClient ? { client: args.mobileClient } : {})
    })
    return isTerminalSendRpcAccepted(response)
  } catch {
    return false
  }
}
