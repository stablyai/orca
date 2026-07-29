import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'

export type { SshPtyDataCallback, SshPtyExitCallback, SshPtyReplayCallback }

export function subscribeSshPtyNotifications(args: {
  mux: SshChannelMultiplexer
  toAppPtyId: (id: string) => string
  dataListeners: Set<SshPtyDataCallback>
  replayListeners: Set<SshPtyReplayCallback>
  exitListeners: Set<SshPtyExitCallback>
  livePtyIds: Set<string>
  recordExit: (relayPtyId: string, incarnationId: unknown) => void
}): () => void {
  return args.mux.onNotification((method, params) => {
    // Why: mux delivers every method to generic handlers; non-PTY payloads
    // (workspace.changed, fs.changed, …) have no `id` and must not reach
    // toAppPtyId → startsWith.
    if (method !== 'pty.exit' && method !== 'pty.data' && method !== 'pty.replay') {
      return
    }
    if (typeof params.id !== 'string' || params.id.length === 0) {
      return
    }
    const relayPtyId = params.id
    const id = args.toAppPtyId(relayPtyId)
    if (method === 'pty.exit') {
      args.recordExit(relayPtyId, params.incarnationId)
      args.livePtyIds.delete(id)
      for (const listener of args.exitListeners) {
        listener({
          id,
          code: params.code as number,
          ...(isPtyIncarnationId(params.incarnationId)
            ? { incarnationId: params.incarnationId }
            : {})
        })
      }
      return
    }
    args.livePtyIds.add(id)
    if (method === 'pty.replay') {
      for (const listener of args.replayListeners) {
        listener({ id, data: params.data as string })
      }
      return
    }
    for (const listener of args.dataListeners) {
      listener({
        id,
        data: params.data as string,
        ...(typeof params.rawLength === 'number' ? { sequenceChars: params.rawLength } : {}),
        ...(params.transformed === true ? { transformed: true } : {}),
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {})
      })
    }
  })
}
