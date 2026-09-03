import { existsSync } from 'node:fs'
import type { Socket } from 'node:net'
import type { PairingTunnel } from '../../shared/mobile-relay-pairing-offer'
import { runProcess, spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { connectThroughSocks5, isSocks5RefusalError } from './socks5-connect'
import { tailcatKeyPathArgument } from './tailcat-binary'
import { guardChildStreams, terminateChild, type TailcatChild } from './tailcat-child-lifecycle'
import { onProcessOutputLines } from './tailcat-process-output'

export type TailcatProcessSpawner = (spec: ProcessSpec) => ReturnType<typeof spawnProcess>
export type TailcatProcessRunner = (spec: ProcessSpec) => ReturnType<typeof runProcess>

export type TailcatSocksProxyOptions = {
  binary: string
  /** Persistent client identity, so a host can later restrict its tunnel to known clients. */
  keyPath: string
  spawn?: TailcatProcessSpawner
  run?: TailcatProcessRunner
  logf?: (message: string) => void
  startTimeoutMs?: number
  terminateGraceMs?: number
  connect?: typeof connectThroughSocks5
  dialRetryDelayMs?: number
}

const SOCKS_LISTEN_PATTERN = /socks5h:\/\/127\.0\.0\.1:(\d+)/
const DEFAULT_START_TIMEOUT_MS = 20_000
const KEYGEN_TIMEOUT_MS = 30_000
// Why: a host that just (re)started is briefly unknown to its relay, and tailcat reports that as a
// generic SOCKS failure. A short retry hides the gap; anything longer is left to the caller's reconnect.
const DIAL_ATTEMPTS = 3
const DEFAULT_DIAL_RETRY_DELAY_MS = 1_500

/**
 * One `tailcat socks` child per Orca process. Destinations are address blobs, so a single proxy
 * reaches every tunnel-shared server without the blob ever appearing in the process table.
 */
export class TailcatSocksProxy {
  private child: TailcatChild | null = null
  private port: number | null = null
  private starting: Promise<number> | null = null
  private stopped = false

  constructor(private readonly options: TailcatSocksProxyOptions) {}

  async dial(tunnel: PairingTunnel): Promise<Socket> {
    const connect = this.options.connect ?? connectThroughSocks5
    for (let attempt = 1; ; attempt += 1) {
      const proxyPort = await this.ensureStarted()
      try {
        return await connect({ proxyPort, host: tunnel.token, port: tunnel.port })
      } catch (error) {
        if (attempt >= DIAL_ATTEMPTS || !isSocks5RefusalError(error)) {
          throw error
        }
        this.options.logf?.(`[tailcat socks] dial attempt ${attempt} failed: ${String(error)}`)
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.dialRetryDelayMs ?? DEFAULT_DIAL_RETRY_DELAY_MS)
        )
      }
    }
  }

  getPort(): number | null {
    return this.port
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    this.child = null
    this.port = null
    if (child) {
      await terminateChild(child, this.options.terminateGraceMs)
    }
  }

  private ensureStarted(): Promise<number> {
    if (this.port !== null) {
      return Promise.resolve(this.port)
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async start(): Promise<number> {
    this.assertNotStopped()
    await this.ensureClientKey()
    // Why: a stop that landed during key generation must not leave an unowned proxy behind.
    this.assertNotStopped()
    const spawn = this.options.spawn ?? spawnProcess
    const child = spawn({
      program: this.options.binary,
      args: [
        `--key=${tailcatKeyPathArgument(this.options.keyPath)}`,
        'socks',
        '--listen=127.0.0.1:0'
      ],
      timeoutMs: null
    })
    guardChildStreams(child, this.options.logf)
    this.child = child
    child.stdout.resume()
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        finish(new Error('Timed out waiting for tailcat socks to start'))
      }, this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
      const detachLines = onProcessOutputLines(child.stderr, (line) => {
        this.options.logf?.(`[tailcat socks] ${line}`)
        const match = SOCKS_LISTEN_PATTERN.exec(line)
        if (match) {
          finish(null, Number(match[1]))
        }
      })
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.child === child) {
          this.child = null
          this.port = null
        }
        finish(new Error(`tailcat socks exited (${signal ?? code ?? 'unknown'})`))
      }
      const onError = (error: Error): void => finish(error)
      const finish = (error: Error | null, port?: number): void => {
        clearTimeout(timeout)
        detachLines()
        child.off('error', onError)
        if (error) {
          child.off('exit', onExit)
          if (this.child === child) {
            this.child = null
          }
          void terminateChild(child, this.options.terminateGraceMs)
          reject(error)
          return
        }
        this.port = port!
        resolve(port!)
      }
      // Why: the exit listener outlives startup so a crashed proxy is respawned on the next dial.
      child.on('exit', onExit)
      child.on('error', onError)
    })
  }

  private assertNotStopped(): void {
    if (this.stopped) {
      throw new Error('Tailcat proxy has been stopped')
    }
  }

  private async ensureClientKey(): Promise<void> {
    if (existsSync(this.options.keyPath)) {
      return
    }
    const run = this.options.run ?? runProcess
    const result = await run({
      program: this.options.binary,
      args: ['genkey', '--client', `--key=${tailcatKeyPathArgument(this.options.keyPath)}`],
      timeoutMs: KEYGEN_TIMEOUT_MS
    })
    if (result.code !== 0) {
      throw new Error(`tailcat genkey --client failed: ${result.stderr.trim() || result.code}`)
    }
  }
}
