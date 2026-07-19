import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../ssh/ssh-connection'
import { shellEscape } from '../ssh/ssh-connection-utils'
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

export class HerdrSshHostTransport implements HerdrHostTransport {
  private executablePromise: Promise<string> | null = null

  constructor(
    private readonly connection: SshConnection,
    private readonly timeoutMs = 15_000,
    private readonly resolveExecutable: () => Promise<string> = async () => 'herdr'
  ) {}

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
    let channel: ClientChannel | null = null
    let released = false
    const subscription = new HerdrEventSubscriptionBuffer(() => {
      released = true
      channel?.end()
      channel?.close()
    })
    void this.open(['--session', sessionName, 'api', 'bridge'])
      .then((opened) => {
        if (released) {
          opened.close()
          return
        }
        channel = opened
        let stdout = ''
        let stderr = ''
        opened.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
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
        opened.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
        opened.once('error', (error: Error) => subscription.fail(error))
        opened.once('close', (code: number) => {
          if (!released && code !== 0) {
            subscription.fail(
              new Error(stderr.trim() || `Remote Herdr event subscription exited with code ${code}`)
            )
          }
        })
        opened.write(herdrEventsSubscribeRequest(afterSequence))
      })
      .catch((error: unknown) => subscription.fail(error))
    return subscription
  }

  controlTerminal(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
    const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
    const pendingFrames: HerdrTerminalFrame[] = []
    let pendingClosed: HerdrTerminalClosed | null = null
    let channel: ClientChannel | null = null
    let released = false
    let stdout = ''
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
      String(options.rows),
      ...(options.takeover ? ['--takeover'] : [])
    ]

    const emitClosed = (event: HerdrTerminalClosed): void => {
      if (closedListeners.size === 0) {
        pendingClosed = event
      } else {
        for (const listener of closedListeners) {
          listener(event)
        }
      }
    }
    void this.open(args)
      .then((opened) => {
        if (released) {
          opened.close()
          return
        }
        channel = opened
        opened.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
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
            } else {
              emitClosed(event)
            }
          }
        })
        opened.once('error', (error: Error) =>
          emitClosed({ type: 'terminal.closed', reason: error.message })
        )
        opened.once('close', (code: number) => {
          if (!released) {
            emitClosed({
              type: 'terminal.closed',
              reason: `Remote Herdr terminal controller exited with code ${code}`
            })
          }
        })
      })
      .catch((error: unknown) =>
        emitClosed({
          type: 'terminal.closed',
          reason: error instanceof Error ? error.message : String(error)
        })
      )

    const send = (message: unknown): void => {
      if (!released && channel?.writable) {
        channel.write(`${JSON.stringify(message)}\n`)
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
        channel?.end()
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

  private async command(args: string[]): Promise<string> {
    this.executablePromise ??= this.resolveExecutable()
    const executable = await this.executablePromise
    return [executable, ...args].map(shellEscape).join(' ')
  }

  private async open(args: string[]): Promise<ClientChannel> {
    return await this.connection.exec(await this.command(args))
  }

  private async run(args: string[]): Promise<string> {
    const channel = await this.open(args)
    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        channel.close()
        reject(new Error(`Remote Herdr command timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      channel.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      channel.once('error', (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      })
      channel.once('close', (code: number) => {
        clearTimeout(timeout)
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(stderr.trim() || `Remote Herdr exited with code ${code}`))
        }
      })
      channel.end()
    })
  }

  private async runRequest(args: string[], input: string, method: string): Promise<string> {
    const channel = await this.open(args)
    return await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error: Error | null, line?: string): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        channel.close()
        if (error) {
          reject(error)
        } else {
          resolve(line as string)
        }
      }
      const timeout = setTimeout(
        () => finish(new Error(`Remote Herdr command timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs
      )
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        const newline = stdout.indexOf('\n')
        if (newline === -1) {
          return
        }
        const line = stdout.slice(0, newline).trim()
        if (line) {
          finish(null, line)
        }
      })
      channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      channel.once('error', (error: Error) => finish(error))
      channel.once('close', (code: number) => {
        if (!settled) {
          finish(
            new Error(
              stderr.trim() ||
                `Remote Herdr returned no response for ${method} (exit ${code ?? 'unknown'})`
            )
          )
        }
      })
      channel.write(input)
    })
  }
}
