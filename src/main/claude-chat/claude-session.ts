import { NdjsonParser } from './ndjson-parser'
import { userInputLine } from './claude-chat-events'
import type { ClaudeStreamEvent } from './claude-chat-events'

type ClaudeChild = {
  stdout: { on(e: 'data', cb: (b: Buffer) => void): void }
  stderr: { on(e: 'data', cb: (b: Buffer) => void): void }
  stdin: { write(s: string): void; end(): void }
  kill(): void
  on(e: 'close', cb: (code: number) => void): void
  on(e: 'error', cb: (err: Error) => void): void
}

type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => ClaudeChild

type ClaudeChatSessionOptions = {
  cwd: string
  spawn: SpawnFn
  onEvent: (event: ClaudeStreamEvent) => void
  model?: string
}

const BASE_ARGS = [
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  // Why: emits stream_event deltas so the UI can render text as it is generated
  // instead of waiting for each complete assistant message.
  '--include-partial-messages'
]

function spawnErrorResult(message: string): ClaudeStreamEvent {
  return {
    type: 'result',
    subtype: 'spawn_error',
    is_error: true,
    errors: [message]
  } as unknown as ClaudeStreamEvent
}

export class ClaudeChatSession {
  private sessionId: string | null = null
  private child: ClaudeChild | null = null
  private readonly opts: ClaudeChatSessionOptions

  constructor(opts: ClaudeChatSessionOptions) {
    this.opts = opts
  }

  send(text: string, opts?: { model?: string; effort?: string }): void {
    this.spawnTurn(text, opts, true)
  }

  private spawnTurn(
    text: string,
    opts: { model?: string; effort?: string } | undefined,
    allowRetry: boolean
  ): void {
    // One turn per process: always spawn a fresh child, use --resume to continue session
    const args = [...BASE_ARGS]
    const resuming = this.sessionId !== null
    if (this.sessionId !== null) {
      args.push('--resume', this.sessionId)
    }
    const model = opts?.model ?? this.opts.model
    if (model !== undefined) {
      args.push('--model', model)
    }
    if (opts?.effort !== undefined) {
      args.push('--effort', opts.effort)
    }

    const parser = new NdjsonParser()
    const child = this.opts.spawn('claude', args, { cwd: this.opts.cwd })
    this.child = child
    let stderrTail = ''
    let sawResult = false
    let retried = false

    const handleEvent = (event: ClaudeStreamEvent): void => {
      // Why: a stale --resume id (deleted/foreign session) poisons every turn.
      // Drop the dead session and transparently replay the message once, fresh.
      if (
        allowRetry &&
        resuming &&
        !retried &&
        event.type === 'result' &&
        Array.isArray((event as { errors?: unknown[] }).errors) &&
        ((event as unknown as { errors: unknown[] }).errors as string[]).some(
          (e) => typeof e === 'string' && e.includes('No conversation found')
        )
      ) {
        retried = true
        this.sessionId = null
        this.spawnTurn(text, opts, false)
        return
      }
      if (event.type === 'result') {
        sawResult = true
      }
      // Capture session_id from the system init event
      if (
        event.type === 'system' &&
        'session_id' in event &&
        typeof event.session_id === 'string'
      ) {
        this.sessionId = event.session_id
      }
      this.opts.onEvent(event)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      for (const event of parser.push(chunk.toString())) {
        handleEvent(event)
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      // Why: keep only the tail — stderr is mostly noise but holds the actual
      // failure message when claude exits without emitting a result event.
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    child.on('error', (err: Error) => {
      // spawn failure (e.g. claude binary not found) — surface it in the chat.
      if (this.child === child) {
        this.child = null
      }
      this.opts.onEvent(spawnErrorResult(`Failed to launch claude: ${err.message}`))
    })

    child.on('close', (code: number) => {
      for (const event of parser.flush()) {
        handleEvent(event)
      }
      // Why: a retry may have already replaced this.child with a fresh process.
      if (this.child === child) {
        this.child = null
      }
      // Why: without a result event the UI would spin forever; synthesize one
      // carrying the stderr tail so the failure is visible.
      if (!sawResult && !retried && code !== 0) {
        this.opts.onEvent(spawnErrorResult(stderrTail.trim() || `claude exited with code ${code}`))
      }
    })

    child.stdin.write(userInputLine(text))
    // End stdin so claude processes the single message and exits cleanly
    child.stdin.end()
  }

  setSessionId(id: string): void {
    // Why: allows the manager to resume a specific historical session before the next send.
    this.sessionId = id
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  isRunning(): boolean {
    return this.child !== null
  }

  stop(): void {
    if (this.child !== null) {
      this.child.kill()
      this.child = null
    }
  }
}

// Production adapter: wraps node's child_process.spawn to match SpawnFn.
// Imported lazily so tests never pull in child_process at module evaluation time.
export function nodeSpawn(cmd: string, args: string[], opts: { cwd: string }): ClaudeChild {
  // require() keeps child_process out of test-bundle evaluation paths
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as {
    spawn: (cmd: string, args: string[], opts: object) => ClaudeChild
  }
  return spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
}
