import { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import { RelayContext } from './context'
import { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'

export function createRelayFileListingRequestHarness() {
  const receive: ((data: Buffer) => void)[] = []
  const dispatcher = new RelayDispatcher((data) => {
    setImmediate(() => receive.forEach((callback) => callback(data)))
    return true
  })
  const mux = new SshChannelMultiplexer({
    write: (data) => {
      setImmediate(() => dispatcher.feed(data))
    },
    onData: (callback) => {
      receive.push(callback)
    },
    onClose: () => {}
  })
  const handler = new FsHandler(dispatcher, new RelayContext())
  return {
    request: async (params: Record<string, unknown>): Promise<string[]> => {
      const value = await mux.request('fs.listFiles', params)
      if (
        !Array.isArray(value) ||
        !value.every((path): path is string => typeof path === 'string')
      ) {
        throw new Error('Expected a file-path array')
      }
      return value
    },
    dispose: () => {
      mux.dispose()
      dispatcher.dispose()
      handler.dispose()
    }
  }
}
