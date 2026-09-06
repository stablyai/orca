import type {
  MobileWebTerminalDeviceInputResult,
  MobileWebTerminalRequest
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'
import type { RpcClient } from '../transport/rpc-client'
import { TerminalStreamOpcode } from '../transport/terminal-stream-protocol'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'
import { sendMobileWebTerminalFrame } from './mobile-web-terminal-host-transport'

type MobileWebTerminalInputRequest = Extract<
  MobileWebTerminalRequest,
  { operation: 'input' | 'queryReply' | 'clipboardPaste' | 'attachImage' }
>

type PreparedDeviceInput = MobileWebTerminalDeviceInputResult & {
  readonly payload?: string
}

export function handleMobileWebTerminalInput(args: {
  client: RpcClient
  record: MobileWebTerminalStreamRecord
  request: MobileWebTerminalInputRequest
  isLive: () => boolean
}): Promise<null | MobileWebTerminalDeviceInputResult> {
  claimInputSequence(args.record, args.request.sequence)
  return enqueueInput(args.record, async () => {
    requireLive(args.isLive)
    if (args.request.operation === 'input' || args.request.operation === 'queryReply') {
      const bytes = atob(args.request.data)
      if (args.request.operation === 'queryReply') {
        // Why: the page's own label is not evidence; the host drops opcode 18 that fails this same grammar check.
        // A host that never echoed the queryReply capability would take the reply as floor-taking
        // shell input, so drop rather than downgrade to opcode 0 (TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY).
        if (!isTerminalQueryReply(bytes) || !args.record.supportsQueryReply) {
          return null
        }
      }
      sendMobileWebTerminalFrame(
        args.client,
        args.record,
        args.request.operation === 'queryReply'
          ? TerminalStreamOpcode.QueryReply
          : TerminalStreamOpcode.Input,
        Uint8Array.from(bytes, (character) => character.charCodeAt(0))
      )
      return null
    }

    const authority = await import('./mobile-web-terminal-device-input-authority')
    const prepared =
      args.request.operation === 'clipboardPaste'
        ? await authority.prepareMobileWebClipboardPaste({
            client: args.client,
            hostWorkspaceId: args.record.hostWorkspaceId,
            bracketedPaste: args.request.bracketedPaste
          })
        : await authority.prepareMobileWebImageAttachment({
            client: args.client,
            hostWorkspaceId: args.record.hostWorkspaceId,
            source: args.request.source
          })
    requireLive(args.isLive)
    sendPreparedDeviceInput(args.client, args.record, prepared)
    return { status: prepared.status }
  })
}

function requireLive(isLive: () => boolean): void {
  if (!isLive()) {
    throw new MobileWebBrokerError('not_found')
  }
}

function claimInputSequence(record: MobileWebTerminalStreamRecord, sequence: number): void {
  if (!record.hostReady || sequence !== record.nextInputSequence) {
    throw new MobileWebBrokerError('conflict')
  }
  record.nextInputSequence += 1
}

function enqueueInput<T>(
  record: MobileWebTerminalStreamRecord,
  operation: () => T | Promise<T>
): Promise<T> {
  const result = record.inputDelivery.then(operation)
  record.inputDelivery = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function sendPreparedDeviceInput(
  client: RpcClient,
  record: MobileWebTerminalStreamRecord,
  prepared: PreparedDeviceInput
): void {
  if (prepared.status !== 'accepted' || !prepared.payload) {
    return
  }
  const bytes = new TextEncoder().encode(prepared.payload)
  for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024) {
    sendMobileWebTerminalFrame(
      client,
      record,
      TerminalStreamOpcode.Input,
      bytes.subarray(offset, Math.min(offset + 16 * 1024, bytes.byteLength))
    )
  }
}
