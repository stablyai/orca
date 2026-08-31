import { decodeTerminalStreamJson } from '../../../../../shared/terminal-stream-protocol'
import { TerminalMultiplexSubscribeFrame } from './stream-schemas'
import type {
  TerminalMultiplexConnection,
  TerminalMultiplexSlotFramesStage
} from './terminal-multiplex-connection'
import { resolveMultiplexSubscribePty } from './terminal-multiplex-subscribe-resolution'
import { initializeMultiplexStream } from './terminal-multiplex-stream-initialization'
import { publishMultiplexInitialSnapshot } from './terminal-multiplex-initial-snapshot'
import { activateMultiplexStream } from './terminal-multiplex-live-stream'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function installMultiplexSubscribeFrame(
  build: TerminalMultiplexSlotFramesStage
): asserts build is TerminalMultiplexConnection {
  const state = build as TerminalMultiplexConnection
  state.handleSubscribeFrame = async (payload) => {
    const raw = decodeTerminalStreamJson<unknown>(payload)
    const parsed = TerminalMultiplexSubscribeFrame.safeParse(raw)
    if (!parsed.success) {
      return
    }
    const request = parsed.data
    const resolution = resolveMultiplexSubscribePty(state, request)
    const ptyId =
      typeof resolution === 'string' || resolution === null ? resolution : await resolution
    if (!ptyId) {
      return
    }
    let stream: TerminalMultiplexStream | null = null
    let installedStream: TerminalMultiplexStream | null = null
    try {
      stream = await initializeMultiplexStream(state, request, ptyId, (installed) => {
        installedStream = installed
      })
    } catch (error) {
      if (!installedStream) {
        throw error
      }
      if (state.streams.get(request.streamId) !== installedStream) {
        return
      }
      state.detachStream(request.streamId, false)
      state.sendStreamError(
        request.streamId,
        error instanceof Error ? error.message : String(error)
      )
      state.emit({ type: 'end', streamId: request.streamId })
      return
    }
    if (!stream) {
      return
    }
    try {
      const published = await publishMultiplexInitialSnapshot(state, request, stream)
      if (!published) {
        return
      }
      activateMultiplexStream(state, request, stream, published)
    } catch (error) {
      // A successor may already own the reused stream ID; never tear it down here.
      if (state.streams.get(request.streamId) !== stream) {
        return
      }
      state.detachStream(request.streamId, false)
      state.sendStreamError(
        request.streamId,
        error instanceof Error ? error.message : String(error)
      )
      state.emit({ type: 'end', streamId: request.streamId })
    }
  }
}
