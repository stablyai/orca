import { spawn } from 'node:child_process'
import type {
  HerdrTerminalClosed,
  HerdrTerminalControlOptions,
  HerdrTerminalController,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import { createHerdrSocketTerminalController } from './herdr-socket-terminal-control'
import type { HerdrSocketEvent } from './herdr-socket-types'

export type HerdrObserveCommand = {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export type HerdrObserveIo = {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  onClosed?: (listener: (event: HerdrTerminalClosed) => void) => () => void
}

/** Read-only `terminal session observe` plus socket write/resize. Does not take exclusive control. */
export function createHerdrObserveController(
  command: HerdrObserveCommand,
  io: HerdrObserveIo
): HerdrTerminalController {
  const child = spawn(command.file, command.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
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
          reason: `Invalid Herdr observe event: ${error instanceof Error ? error.message : String(error)}`
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
        reason: `Herdr observe exited with code ${code ?? 'unknown'}`
      })
    }
  })
  const stopSocketClosed = io.onClosed?.((event) => {
    if (!released) {
      emitClosed(event)
    }
  })

  return {
    write: (data) => {
      if (!released) {
        io.write(data)
      }
    },
    resize: (cols, rows) => {
      if (!released) {
        io.resize(cols, rows)
      }
    },
    release: () => {
      if (released) {
        return
      }
      released = true
      stopSocketClosed?.()
      child.kill()
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

export function createStockHerdrTerminalController(
  sessionName: string,
  target: string,
  options: HerdrTerminalControlOptions,
  deps: {
    commandFor?: (args: string[]) => HerdrObserveCommand
    request: (method: string, params: unknown) => Promise<unknown>
    onEvent: (listener: (event: HerdrSocketEvent) => void) => () => void
  }
): HerdrTerminalController {
  if (deps.commandFor) {
    return createHerdrObserveController(
      deps.commandFor([
        '--session',
        sessionName,
        'terminal',
        'session',
        'observe',
        target,
        '--cols',
        String(options.cols),
        '--rows',
        String(options.rows)
      ]),
      {
        write: (data) => {
          void deps
            .request('pane.send_input', { pane_id: target, text: data })
            .catch(() => undefined)
        },
        resize: (cols, rows) => {
          void deps.request('pane.resize', { pane_id: target, cols, rows }).catch(() => undefined)
        },
        onClosed: (listener) =>
          deps.onEvent((event) => {
            if (
              event.event === 'pane.exited' &&
              (event.data as { pane_id?: string }).pane_id === target
            ) {
              listener({ type: 'terminal.closed', reason: 'pane_exited' })
            }
          })
      }
    )
  }
  return createHerdrSocketTerminalController(target, options, {
    request: deps.request,
    subscribeEvents: deps.onEvent
  })
}
