import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalClosed,
  HerdrTerminalController,
  HerdrTerminalControlOptions,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import type { HerdrEventSubscriptionBuffer } from './herdr-event-subscription'
import { createHerdrCliEventSubscription } from './herdr-cli-event-subscription'
import type { HerdrCommand } from './herdr-command'

export { localHerdrCommand } from './herdr-command'

export type HerdrCliHostTransportOptions = {
  commandFor: (herdrArgs: string[]) => HerdrCommand
  timeoutMs?: number
}

export class HerdrCliHostTransport implements HerdrHostTransport {
  private readonly timeoutMs: number

  constructor(private readonly options: HerdrCliHostTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async ensureSession(sessionName: string): Promise<void> {
    await this.run(['session', 'ensure', sessionName, '--json'])
  }

  async request<T>(
    sessionName: string,
    method: string,
    params: unknown
  ): Promise<HerdrResponse<T>> {
    const request = `${JSON.stringify({ id: randomUUID(), method, params })}\n`
    const line = await this.runRequest(['--session', sessionName, 'api', 'bridge'], request, method)
    return JSON.parse(line) as HerdrResponse<T>
  }

  subscribeEvents(sessionName: string, afterSequence: number): HerdrEventSubscriptionBuffer {
    return createHerdrCliEventSubscription(this.options.commandFor, sessionName, afterSequence)
  }

  controlTerminal(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
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
    const command = this.options.commandFor(args)
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
      } else {
        for (const listener of closedListeners) {
          listener(event)
        }
      }
    }

    child.stdout.setEncoding('utf8')
    // Why: a long-lived controller must consume stderr or its pipe can block Herdr.
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
            } else {
              for (const listener of frameListeners) {
                listener(event)
              }
            }
          } else if (event.type === 'terminal.closed') {
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
      if (released) {
        return
      }
      emitClosed({ type: 'terminal.closed', reason: error.message })
    })
    child.once('close', (code) => {
      if (released) {
        return
      }
      const event: HerdrTerminalClosed = {
        type: 'terminal.closed',
        reason: `Herdr terminal controller exited with code ${code ?? 'unknown'}`
      }
      emitClosed(event)
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

  private async run(args: string[], input?: string): Promise<string> {
    const command = this.options.commandFor(args)
    return await new Promise((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(command.env ? { env: command.env } : {})
      })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Herdr command timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => (stdout += chunk))
      child.stderr.on('data', (chunk: string) => (stderr += chunk))
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr.trim() || `Herdr exited with code ${code ?? 'unknown'}`))
        }
      })
      child.stdin.end(input)
    })
  }

  private async runRequest(args: string[], input: string, method: string): Promise<string> {
    const command = this.options.commandFor(args)
    return await new Promise((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(command.env ? { env: command.env } : {})
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error: Error | null, line?: string): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        child.kill()
        if (error) {
          reject(error)
        } else {
          resolve(line as string)
        }
      }
      const timeout = setTimeout(
        () => finish(new Error(`Herdr command timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs
      )
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
        const newline = stdout.indexOf('\n')
        if (newline === -1) {
          return
        }
        const line = stdout.slice(0, newline).trim()
        if (line) {
          finish(null, line)
        }
      })
      child.stderr.on('data', (chunk: string) => (stderr += chunk))
      child.once('error', (error) => finish(error))
      child.once('close', (code) => {
        if (!settled) {
          finish(
            new Error(
              stderr.trim() ||
                `Herdr returned no response for ${method} (exit ${code ?? 'unknown'})`
            )
          )
        }
      })
      child.stdin.write(input)
    })
  }
}
