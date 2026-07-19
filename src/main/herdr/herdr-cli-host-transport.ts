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
import {
  HerdrEventSubscriptionBuffer,
  herdrEventsSubscribeRequest
} from './herdr-event-subscription'

export type HerdrCommand = { file: string; args: string[] }

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
    const command = this.options.commandFor(['--session', sessionName, 'api', 'bridge'])
    const child = spawn(command.file, command.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const subscription = new HerdrEventSubscriptionBuffer(() => {
      child.stdin.end()
      child.kill()
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
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
          subscription.acceptLine(line)
        } catch (error) {
          subscription.fail(error)
        }
      }
    })
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.once('error', (error) => subscription.fail(error))
    child.once('close', (code) => {
      if (code !== 0) {
        subscription.fail(
          new Error(
            stderr.trim() || `Herdr event subscription exited with code ${code ?? 'unknown'}`
          )
        )
      }
    })
    child.stdin.write(herdrEventsSubscribeRequest(afterSequence))
    return subscription
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
      windowsHide: true
    })
    const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
    const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
    const pendingFrames: HerdrTerminalFrame[] = []
    let pendingClosed: HerdrTerminalClosed | null = null
    let stdout = ''
    let released = false

    child.stdout.setEncoding('utf8')
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
          if (closedListeners.size === 0) {
            pendingClosed = event
          } else {
            for (const listener of closedListeners) {
              listener(event)
            }
          }
        }
      }
    })
    child.once('error', (error) => {
      const event: HerdrTerminalClosed = { type: 'terminal.closed', reason: error.message }
      for (const listener of closedListeners) {
        listener(event)
      }
    })
    child.once('close', (code) => {
      if (released) {
        return
      }
      const event: HerdrTerminalClosed = {
        type: 'terminal.closed',
        reason: `Herdr terminal controller exited with code ${code ?? 'unknown'}`
      }
      for (const listener of closedListeners) {
        listener(event)
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
        windowsHide: true
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
        windowsHide: true
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

export function localHerdrCommand(executable = 'herdr'): (args: string[]) => HerdrCommand {
  return (args) => ({ file: executable, args })
}
