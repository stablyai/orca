import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshChannelMultiplexer, type MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'
import {
  encodeJsonRpcFrame,
  HEADER_LENGTH,
  MessageType,
  parseJsonRpcMessage,
  type JsonRpcMessage
} from '../ssh/relay-protocol'

export function createSshFileExplorerWatchTestConnection(
  rootPath = '/remote/repo',
  connectionId = 'ssh-1'
) {
  const written: Buffer[] = []
  let receive: (data: Buffer) => void = () => undefined
  let sequence = 1
  const transport: MultiplexerTransport = {
    write: (data) => {
      written.push(data)
    },
    onData: (callback) => {
      receive = callback
    },
    onClose: () => undefined
  }
  const mux = new SshChannelMultiplexer(transport)
  const provider = new SshFilesystemProvider(connectionId, mux)
  const messages = (): JsonRpcMessage[] =>
    written
      .filter((frame) => frame[0] === MessageType.Regular)
      .map((frame) => parseJsonRpcMessage(frame.subarray(HEADER_LENGTH)))
  const send = (message: JsonRpcMessage): void => {
    receive(encodeJsonRpcFrame(message, sequence++, 0))
  }
  const watchRequest = () => {
    const request = messages().find(
      (message) => 'method' in message && message.method === 'fs.watch'
    )
    if (!request || !('id' in request) || !('method' in request)) {
      throw new Error('No pending fs.watch request')
    }
    return request
  }
  return {
    mux,
    provider,
    countRequests: (method: string) =>
      messages().filter((message) => 'method' in message && message.method === method).length,
    settleWatch: () => send({ jsonrpc: '2.0', id: watchRequest().id, result: null }),
    emitChange: (absolutePath = `${rootPath}/current.ts`) =>
      send({
        jsonrpc: '2.0',
        method: 'fs.changed',
        params: { events: [{ kind: 'update', absolutePath }] }
      }),
    failWatch: (message: string) => {
      const watchId = watchRequest().params?.watchId
      if (typeof watchId !== 'number') {
        throw new Error('No remote watch id')
      }
      send({ jsonrpc: '2.0', method: 'fs.watchFailed', params: { rootPath, watchId, message } })
    }
  }
}
