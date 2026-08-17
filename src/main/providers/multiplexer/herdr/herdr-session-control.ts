import { spawn } from 'node:child_process'
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

/** Exclusive stdin JSON: terminal.input, terminal.resize, terminal.release. */
export function createHerdrSessionControlController(
  command: HerdrSessionControlCommand
): HerdrTerminalController {
  const child = spawn(command.file, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(command.env ? { env: command.env } : {})
  })
  const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
  const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
  const pendingFrames: HerdrTerminalFrame[] = []
  let pendingClosed: HerdrTerminalClosed | null = null
  let stdout = ''
  let released = false

  const emitClosed = (event: HerdrTerminalClosed): void => {
    if (closedListeners.size === 0) {
      pendingClosed = event
      return
    }
    for (const listener of closedListeners) {
      listener(event)
    }
  }

  child.stdout.setEncoding('utf8')
  child.stderr.on('data', () => undefined)
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline === -1) {
        break
      }
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (!line) {
        continue
      }
      try {
        const event = JSON.parse(line) as HerdrTerminalFrame | HerdrTerminalClosed
        if (event.type === 'terminal.frame') {
          if (frameListeners.size === 0) {
            pendingFrames.push(event)
            if (pendingFrames.length > 512) {
              pendingFrames.shift()
            }
          } else {
            for (const listener of frameListeners) {
              listener(event)
            }
          }
        } else {
          emitClosed(event)
        }
      } catch (error) {
        released = true
        emitClosed({
          type: 'terminal.closed',
          reason: `Invalid Herdr terminal event: ${error instanceof Error ? error.message : String(error)}`
        })
        child.kill()
        return
      }
    }
  })
  child.once('error', (error) => {
    if (!released) {
      emitClosed({ type: 'terminal.closed', reason: error.message })
    }
  })
  child.once('close', (code) => {
    if (!released) {
      emitClosed({
        type: 'terminal.closed',
        reason: `Herdr terminal controller exited with code ${code ?? 'unknown'}`
      })
    }
  })

  const send = (message: unknown): void => {
    if (!released && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
  }
  return {
    write: (data) => send({ type: 'terminal.input', text: data }),
    resize: (cols, rows) => send({ type: 'terminal.resize', cols, rows }),
    release: () => {
      if (released) {
        return
      }
      send({ type: 'terminal.release' })
      released = true
      child.stdin.end()
      const killTimer = setTimeout(() => child.kill(), 2_000)
      child.once('close', () => clearTimeout(killTimer))
    },
    onFrame: (listener) => {
      frameListeners.add(listener)
      for (const frame of pendingFrames.splice(0)) {
        listener(frame)
      }
      return () => frameListeners.delete(listener)
    },
    onClosed: (listener) => {
      closedListeners.add(listener)
      if (pendingClosed) {
        listener(pendingClosed)
        pendingClosed = null
      }
      return () => closedListeners.delete(listener)
    }
  }
}
