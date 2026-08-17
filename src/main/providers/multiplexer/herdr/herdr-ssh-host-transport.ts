import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../../../ssh/ssh-remote-platform'
import type {
  HerdrHostTransport,
  HerdrResponse,
  HerdrTerminalClosed,
  HerdrTerminalController,
  HerdrTerminalControlOptions,
  HerdrTerminalFrame
} from './herdr-runtime-contract'
import { herdrStockCliInvocation } from './herdr-stock-cli-request'
import { HerdrSshSessionManager } from './herdr-ssh-session'

export class HerdrSshHostTransport implements HerdrHostTransport {
  private readonly sessionManager: HerdrSshSessionManager

  constructor(
    private readonly connection: SshConnection,
    private readonly timeoutMs = 15_000,
    private readonly resolveExecutable: () => Promise<string> = async () => 'herdr',
    private readonly hostPlatform?: RemoteHostPlatform,
    sessionManager?: HerdrSshSessionManager
  ) {
    this.sessionManager =
      sessionManager ??
      new HerdrSshSessionManager(connection, timeoutMs, resolveExecutable, hostPlatform)
  }

  // Expose for testing/debugging
  getConnection() {
    return this.connection
  }
  getTimeoutMs() {
    return this.timeoutMs
  }
  getResolveExecutable() {
    return this.resolveExecutable
  }
  getHostPlatform() {
    return this.hostPlatform
  }

  async ensureSession(sessionName: string): Promise<void> {
    await this.sessionManager.ensureSession(sessionName)
  }

  async request<T>(
    sessionName: string,
    method: string,
    params: unknown
  ): Promise<HerdrResponse<T>> {
    const invocation = herdrStockCliInvocation(sessionName, method, params)
    return invocation.parse(await this.sessionManager.run(invocation.args)) as HerdrResponse<T>
  }

  controlTerminal(
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    const frameListeners = new Set<(frame: HerdrTerminalFrame) => void>()
    const closedListeners = new Set<(event: HerdrTerminalClosed) => void>()
    const pendingFrames: HerdrTerminalFrame[] = []
    const pendingMessages: string[] = []
    let pendingClosed: HerdrTerminalClosed | null = null
    let channel: ClientChannel | null = null
    let released = false
    let closedEmitted = false
    const stdoutDecoder = new StringDecoder('utf8')
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
      if (closedEmitted) {
        return
      }
      closedEmitted = true
      if (closedListeners.size === 0) {
        pendingClosed = event
        return
      }
      for (const listener of closedListeners) {
        listener(event)
      }
    }

    void this.sessionManager
      .open(args)
      .then((opened) => {
        if (released) {
          opened.close()
          return
        }
        channel = opened
        for (const m of pendingMessages.splice(0)) {
          opened.write(m)
        }
        opened.stderr.on('data', () => undefined)
        opened.on('data', (chunk: Buffer) => {
          stdout += stdoutDecoder.write(chunk)
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
              } else {
                emitClosed(event)
              }
            } catch (error) {
              released = true
              emitClosed({
                type: 'terminal.closed',
                reason: `Invalid Herdr terminal event: ${error instanceof Error ? error.message : String(error)}`
              })
              opened.close()
              return
            }
          }
        })
        opened.once('error', (error: Error) => {
          if (!released) {
            emitClosed({ type: 'terminal.closed', reason: error.message })
          }
        })
        opened.once('close', (code: number) => {
          if (!released) {
            emitClosed({
              type: 'terminal.closed',
              reason: `Remote Herdr terminal controller exited with code ${code}`
            })
          }
        })
      })
      .catch((error: unknown) => {
        emitClosed({
          type: 'terminal.closed',
          reason: error instanceof Error ? error.message : String(error)
        })
      })

    const send = (message: unknown): void => {
      if (released) {
        return
      }
      const encoded = `${JSON.stringify(message)}\n`
      if (!channel) {
        pendingMessages.push(encoded)
      } else if (channel.writable) {
        channel.write(encoded)
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
}
