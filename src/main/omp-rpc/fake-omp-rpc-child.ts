import { join } from 'node:path'
import type {
  OmpRpcSessionState,
  OmpRpcSlashCommand,
  OmpRpcSpawnOptions
} from '../../shared/omp-rpc-protocol'

export type FakeOmpRpcScenario = {
  firstFrame?: unknown
  /** Fields merged over the fake's default ready frame (e.g. another OMP
   *  release's framing envelope). */
  readyFrameOverrides?: Record<string, unknown>
  negotiationResponse?: unknown
  afterNegotiationFrames?: unknown[]
  commands?: OmpRpcSlashCommand[]
  commandErrors?: Partial<
    Record<
      | 'abort'
      | 'get_available_commands'
      | 'get_state'
      | 'get_messages_page'
      | 'prompt'
      | 'steer'
      | 'follow_up'
      | 'switch_session'
      | 'set_subagent_subscription',
      { error: string; code?: string }
    >
  >
  /** Path to append every inbound command to, as JSONL, so a test can assert
   *  the exact wire shape the client sent. */
  commandMarkerPath?: string
  promptOutput?: string[]
  promptResultAgentInvoked?: boolean
  promptAgentInvoked?: boolean
  /** OMP may acknowledge a prompt before asynchronous extension work settles. */
  promptImmediateAcknowledgement?: boolean
  /** An asynchronous scheduling failure reuses the prompt request id. */
  promptAsyncError?: { error: string; code?: string }
  /** Frames written (in order) when a `prompt` command is received, before its
   *  correlated response — simulates a real agent_start / message_* / agent_end run. */
  promptEvents?: unknown[]
  /** Same as `promptEvents` but for `steer` / `follow_up` commands. */
  steerEvents?: unknown[]
  followUpEvents?: unknown[]
  steerAgentInvoked?: boolean
  followUpAgentInvoked?: boolean
  /** Path to append every inbound `extension_ui_response` command to, as JSONL,
   *  so a test can assert what the client answered. */
  extensionUiResponseMarkerPath?: string
  chunkedCommandOutputLength?: number
  chunkFault?:
    | 'wrong-start-index'
    | 'chunk-id-mismatch'
    | 'interleaved-frame'
    | 'byte-length-mismatch'
  malformedAfterNegotiationLine?: string
  /** Garbage written in the SAME stdout chunk as a `get_state` response, which
   *  is what makes the client fault between resolving that command and its
   *  caller's continuation (XLR-R6-001). */
  malformedAfterGetState?: string
  exitOnCommand?: 'get_available_commands' | 'prompt' | 'switch_session'
  exitCode?: number
  stderrBeforeExit?: string
  sigtermMarkerPath?: string
  argvMarkerPath?: string
  sessionState?: OmpRpcSessionState
  /** History the fake pages out of `get_messages_page`, cursor/limit honored
   *  exactly as upstream does (offset cursor, `nextCursor` only when more remain). */
  historyMessages?: Record<string, unknown>[]
  /** Returned verbatim as the `get_messages_page` payload, to exercise validation. */
  historyMalformedPage?: unknown
  /** Path to append every inbound `get_messages_page` command to, as JSONL. */
  historyPageMarkerPath?: string
  /** Applied to the reported session state when a `prompt` arrives — the only
   *  trace a session-changing slash command leaves on the wire. */
  promptSessionChange?: Partial<OmpRpcSessionState>
  /** Command types the child reads and never answers — a live process that has
   *  stopped responding, which is what the client's response deadline covers. */
  swallowCommands?: string[]
}

export type FakeOmpRpcChild = {
  argv: string[]
  spawnOptions: OmpRpcSpawnOptions
}

export function createFakeOmpRpcChild(
  scenario: FakeOmpRpcScenario,
  sessionMode: 'session-less' | 'session-owning' = 'session-less'
): FakeOmpRpcChild {
  const fixtureDirectory = join(process.cwd(), 'src', 'main', 'omp-rpc')
  const scriptPath = join(fixtureDirectory, 'fake-omp-rpc-child-script.mjs')
  const executablePath =
    process.platform === 'win32' ? join(fixtureDirectory, 'fake-omp-rpc-child.cmd') : scriptPath
  const scenarioJson = JSON.stringify(scenario)
  const rpcArgs = [
    '--mode',
    'rpc',
    ...(sessionMode === 'session-less' ? ['--no-session'] : []),
    scenarioJson
  ]
  const spawnOptions: OmpRpcSpawnOptions =
    sessionMode === 'session-owning'
      ? {
          executablePath,
          cwd: process.cwd(),
          sessionMode,
          extraArgs: [scenarioJson]
        }
      : {
          executablePath,
          cwd: process.cwd(),
          sessionMode,
          noSession: true,
          extraArgs: [scenarioJson]
        }
  return {
    argv: [process.execPath, scriptPath, ...rpcArgs],
    spawnOptions
  }
}
