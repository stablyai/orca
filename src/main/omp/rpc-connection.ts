import { z } from 'zod'
import {
  JsonlRpcAgentConnection,
  type JsonlRpcAgentConnectionOptions
} from '../jsonl-rpc/agent-connection'
import { JsonlRpcResponseError, type JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { PiRpcConnection } from '../pi/rpc-session'
import { OmpRpcFrameDecoder, encodeOmpRpcFrame } from './rpc-frame-decoder'
import { OmpRpcCommandPolicy } from './rpc-command-policy'
import { jsonlRpcRequestTimeout } from '../jsonl-rpc/peer-limits'

const stateSchema = z.looseObject({
  isSettled: z.boolean(),
  queuedMessageCount: z.number().nonnegative(),
  sessionFile: z.string().min(1)
})

/** The existing session lane consumes Pi's common message vocabulary; OMP keeps its own wire protocol. */
export function openOmpRpcConnection(
  launch: ProviderProcessLaunch,
  handlers: JsonlRpcAgentConnectionOptions
): PiRpcConnection {
  const decoder = new OmpRpcFrameDecoder()
  const commands = new OmpRpcCommandPolicy()
  const ready = Promise.withResolvers<void>()
  let initialized: Promise<void> | undefined
  const raw = new JsonlRpcAgentConnection(launch, {
    ...handlers,
    decodeRecord: (frame) =>
      decoder.decode(frame).map((record) => {
        const response = z
          .looseObject({
            type: z.literal('response'),
            command: z.literal('prompt'),
            id: z.string()
          })
          .safeParse(record)
        if (!response.success) {
          return record
        }
        const { id, ...rest } = response.data
        return { ...rest, promptId: id }
      }),
    encodeRecord: encodeOmpRpcFrame,
    onRecord: (frame) => {
      if (frame.type === 'ready') {
        const result = z.object({ supportedProtocolVersions: z.array(z.number()) }).parse(frame)
        if (!result.supportedProtocolVersions.includes(2)) {
          throw new Error('OMP RPC protocol v2 is required')
        }
        ready.resolve()
        return
      }
      if (frame.type === 'session_settled') {
        handlers.onRecord?.({ type: 'agent_settled' })
        return
      }
      if (frame.type === 'available_commands_update') {
        commands.update(frame)
      }
      handlers.onRecord?.(frame)
    },
    onClose: (error) => {
      ready.reject(error)
      handlers.onClose?.(error)
    }
  })
  void ready.promise.catch(() => {})
  const initialize = (): Promise<void> =>
    (initialized ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ready.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('OMP RPC readiness timed out')), 30_000)
            timer.unref()
          })
        ])
        z.object({ protocolVersion: z.literal(2) }).parse(
          await raw.request('negotiate_protocol', { protocolVersion: 2 })
        )
        try {
          await raw.request('set_ask_dialog', { enabled: true })
        } catch (error) {
          if (
            !(error instanceof JsonlRpcResponseError) ||
            error.command !== 'set_ask_dialog' ||
            error.message !== 'Unknown command: set_ask_dialog'
          ) {
            throw error
          }
        }
        commands.update(await raw.request('get_available_commands'))
      } finally {
        clearTimeout(timer)
      }
    })())
  const request: PiRpcConnection['request'] = async (command, params = {}, options = {}) => {
    const timeoutMs =
      options.timeoutMs === null ? null : jsonlRpcRequestTimeout(options.timeoutMs ?? 30_000)
    const deadline = timeoutMs === null ? null : performance.now() + timeoutMs
    const timeoutError = () => new Error(`Agent did not answer ${command} in time`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await (timeoutMs === null
        ? initialize()
        : Promise.race([
            initialize(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(timeoutError()), timeoutMs)
              timer.unref()
            })
          ]))
    } finally {
      clearTimeout(timer)
    }
    const remaining = deadline === null ? null : Math.ceil(deadline - performance.now())
    if (remaining !== null && remaining <= 0) {
      throw timeoutError()
    }
    const answer = await raw.request(
      command === 'get_commands' ? 'get_available_commands' : command,
      params,
      { ...options, timeoutMs: remaining }
    )
    if (command === 'get_state') {
      const state = stateSchema.parse(answer)
      handlers.onRecord?.({ type: 'omp_state', state })
      return {
        ...state,
        pendingMessageCount: state.isSettled ? 0 : Math.max(1, state.queuedMessageCount)
      }
    }
    if (command === 'get_commands') {
      return commands.update(answer)
    }
    return answer
  }
  return {
    get pid() {
      return raw.pid
    },
    get closed() {
      return raw.closed
    },
    get rootVerdict() {
      return raw.rootVerdict
    },
    get processless() {
      return raw.processless
    },
    get spawnAbsence() {
      return raw.spawnAbsence
    },
    get lastCloseResult() {
      return raw.lastCloseResult
    },
    onExit: (listener) => raw.onExit(listener),
    pauseReading: () => raw.pauseReading(),
    resumeReading: () => raw.resumeReading(),
    close: (error) => raw.close(error),
    request,
    thinkingLevels: async () =>
      z
        .object({ levels: z.array(z.string()) })
        .parse(await request('get_available_thinking_levels')).levels,
    send: async (frame: JsonlRpcRecord) => {
      await initialize()
      if (frame.type === 'prompt' && commands.refuses(frame.message)) {
        handlers.onRecord?.({
          type: 'response',
          command: 'prompt',
          promptId: frame.id,
          success: false,
          error:
            'Change the working folder through Orca. OMP session relocation commands are unavailable in this chat.'
        })
        return
      }
      return raw.send(frame)
    }
  }
}
