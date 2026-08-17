import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type {
  HerdrTerminalClosed,
  HerdrTerminalController,
  HerdrTerminalControlOptions,
  HerdrTerminalFrame
} from './herdr-runtime-contract'

export type HerdrSessionControlCommand = {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export type HerdrSessionControlStream = {
  writable: boolean
  write(data: string): void
  end(): void
  close(): void
  onData(listener: (chunk: string) => void): void
  onError(listener: (error: Error) => void): void
  onClose(listener: (code: number | null) => void): void
}

export type HerdrSessionControlChannel = {
  writable: boolean
  write(data: string): void
  end(): void
  close(): void
  on(event: 'data', listener: (chunk: Buffer) => void): void
  once(event: 'error', listener: (error: Error) => void): void
  once(event: 'close', listener: (code?: number) => void): void
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): void }
}

export function herdrSessionControlArgs(
  sessionName: string,
  target: string,
  options: HerdrTerminalControlOptions
): string[] {
  const args = [
    '--session',
    sessionName,
    'terminal',
    'session',
    'control',
    target,
    '--cols',
    String(options.cols),
    '--rows',
    String(options.rows)
  ]
  if (options.takeover) {
    args.push('--takeover')
  }
  return args
}

export function herdrSessionControlStreamFromChannel(
  channel: HerdrSessionControlChannel
): HerdrSessionControlStream {
  const decoder = new StringDecoder('utf8')
  channel.stderr?.on('data', () => undefined)
  return {
    get writable() {
      return channel.writable
    },
    write: (data) => {
      if (channel.writable) {
        channel.write(data)
      }
    },
    end: () => channel.end(),
    close: () => channel.close(),
    onData: (listener) => {
      channel.on('data', (chunk) => listener(decoder.write(chunk)))
    },
    onError: (listener) => {
      channel.once('error', listener)
    },
    onClose: (listener) => {
      channel.once('close', (code) => listener(code ?? null))
    }
  }
}

type SessionControlState = {
  frameListeners: Set<(frame: HerdrTerminalFrame) => void>
  closedListeners: Set<(event: HerdrTerminalClosed) => void>
  pendingFrames: HerdrTerminalFrame[]
  pendingMessages: string[]
  pendingClosed: HerdrTerminalClosed | null
  stream: HerdrSessionControlStream | null
  stdout: string
  released: boolean
  closedEmitted: boolean
}

function createSessionControlState(): SessionControlState {
  return {
    frameListeners: new Set(),
    closedListeners: new Set(),
    pendingFrames: [],
    pendingMessages: [],
    pendingClosed: null,
    stream: null,
    stdout: '',
    released: false,
    closedEmitted: false
  }
}

function emitClosed(state: SessionControlState, event: HerdrTerminalClosed): void {
  if (state.closedEmitted) {
    return
  }
  state.closedEmitted = true
  if (state.closedListeners.size === 0) {
    state.pendingClosed = event
    return
  }
  for (const listener of state.closedListeners) {
    listener(event)
  }
}

function consumeLine(state: SessionControlState, line: string, onInvalid: () => void): void {
  if (!line) {
    return
  }
  try {
    const event = JSON.parse(line) as HerdrTerminalFrame | HerdrTerminalClosed
    if (event.type === 'terminal.frame') {
      if (state.frameListeners.size === 0) {
        state.pendingFrames.push(event)
        if (state.pendingFrames.length > 512) {
          state.pendingFrames.shift()
        }
      } else {
        for (const listener of state.frameListeners) {
          listener(event)
        }
      }
      return
    }
    emitClosed(state, event)
  } catch (error) {
    state.released = true
    emitClosed(state, {
      type: 'terminal.closed',
      reason: `Invalid Herdr terminal event: ${error instanceof Error ? error.message : String(error)}`
    })
    onInvalid()
  }
}

function attachSessionControlStream(
  state: SessionControlState,
  stream: HerdrSessionControlStream
): void {
  if (state.released) {
    stream.close()
    return
  }
  state.stream = stream
  for (const message of state.pendingMessages.splice(0)) {
    stream.write(message)
  }
  stream.onData((chunk) => {
    state.stdout += chunk
    for (;;) {
      const newline = state.stdout.indexOf('\n')
      if (newline === -1) {
        break
      }
      const line = state.stdout.slice(0, newline).trim()
      state.stdout = state.stdout.slice(newline + 1)
      consumeLine(state, line, () => stream.close())
      if (state.released) {
        return
      }
    }
  })
  stream.onError((error) => {
    if (!state.released) {
      emitClosed(state, { type: 'terminal.closed', reason: error.message })
    }
  })
  stream.onClose((code) => {
    if (!state.released) {
      emitClosed(state, {
        type: 'terminal.closed',
        reason: `Herdr terminal controller exited with code ${code ?? 'unknown'}`
      })
    }
  })
}

function sessionControlController(state: SessionControlState): HerdrTerminalController {
  const send = (message: unknown): void => {
    if (state.released) {
      return
    }
    const encoded = `${JSON.stringify(message)}\n`
    if (!state.stream) {
      state.pendingMessages.push(encoded)
      return
    }
    state.stream.write(encoded)
  }

  return {
    write: (data) => send({ type: 'terminal.input', text: data }),
    resize: (cols, rows) => send({ type: 'terminal.resize', cols, rows }),
    release: () => {
      if (state.released) {
        return
      }
      send({ type: 'terminal.release' })
      state.released = true
      state.stream?.end()
      const killTimer = setTimeout(() => state.stream?.close(), 2_000)
      state.stream?.onClose(() => clearTimeout(killTimer))
    },
    onFrame: (listener) => {
      state.frameListeners.add(listener)
      for (const frame of state.pendingFrames.splice(0)) {
        listener(frame)
      }
      return () => state.frameListeners.delete(listener)
    },
    onClosed: (listener) => {
      state.closedListeners.add(listener)
      if (state.pendingClosed) {
        listener(state.pendingClosed)
        state.pendingClosed = null
      }
      return () => state.closedListeners.delete(listener)
    }
  }
}

/** Exclusive stdin JSON: terminal.input, terminal.resize, terminal.release. */
export function createHerdrSessionControlFromOpen(
  open: () => Promise<HerdrSessionControlStream>
): HerdrTerminalController {
  const state = createSessionControlState()
  void open()
    .then((opened) => attachSessionControlStream(state, opened))
    .catch((error: unknown) => {
      emitClosed(state, {
        type: 'terminal.closed',
        reason: error instanceof Error ? error.message : String(error)
      })
    })
  return sessionControlController(state)
}

export function createHerdrSessionControlController(
  command: HerdrSessionControlCommand
): HerdrTerminalController {
  const child = spawn(command.file, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(command.env ? { env: command.env } : {})
  })
  child.stdout.setEncoding('utf8')
  child.stderr.on('data', () => undefined)
  const state = createSessionControlState()
  attachSessionControlStream(state, {
    get writable() {
      return child.stdin.writable
    },
    write: (data) => {
      if (child.stdin.writable) {
        child.stdin.write(data)
      }
    },
    end: () => child.stdin.end(),
    close: () => child.kill(),
    onData: (listener) => {
      child.stdout.on('data', listener)
    },
    onError: (listener) => {
      child.once('error', listener)
    },
    onClose: (listener) => {
      child.once('close', (code) => listener(code ?? null))
    }
  })
  return sessionControlController(state)
}
