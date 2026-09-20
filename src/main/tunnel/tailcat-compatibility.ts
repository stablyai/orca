import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { tailcatKeyPathArgument } from './tailcat-binary'
import { guardChildStreams, terminateChild } from './tailcat-child-lifecycle'
import { onProcessOutputLines } from './tailcat-process-output'
import type { TailcatProcessRunner, TailcatProcessSpawner } from './tailcat-socks-proxy'

export type TailcatCompatibility =
  | { ok: true; version: string | null }
  | { ok: false; version: string | null; reason: string }

export type TailcatCompatibilityProbeOptions = {
  run?: TailcatProcessRunner
  spawn?: TailcatProcessSpawner
  timeoutMs?: number
  signal?: AbortSignal
  /** Where the throwaway probe keys go; defaults to a fresh temp directory that is removed afterwards. */
  probeDirectory?: string
}

const DEFAULT_STEP_TIMEOUT_MS = 10_000
// Why: any relay region id works for a key that is only parsed, never served; 302 is Tailscale's SFO relay.
const PROBE_REGION_ID = '302'
const SOCKS_LISTEN_PATTERN = /socks5h:\/\/127\.0\.0\.1:(\d+)/
export const TAILCAT_INCOMPATIBLE_HINT =
  'Orca drives tailcat 0.4 or newer (subcommand syntax, --json, genkey). Upgrade tailcat and try again.'

/**
 * Proves, without touching the network, that this `tailcat` speaks the commands Orca drives:
 * `genkey` for server and client keys, `parse` on the resulting token, and `socks` reaching its
 * ready line. Version output is recorded but never trusted, because source builds report `(devel)`.
 */
export async function probeTailcatBinary(
  binary: string,
  options: TailcatCompatibilityProbeOptions = {}
): Promise<TailcatCompatibility> {
  const run = options.run ?? runProcess
  const spawn = options.spawn ?? spawnProcess
  const timeoutMs = options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const signal = options.signal
  const ownsDirectory = options.probeDirectory === undefined
  const directory = options.probeDirectory ?? mkdtempSync(join(tmpdir(), 'orca-tailcat-probe-'))
  let version: string | null = null
  try {
    signal?.throwIfAborted()
    version = await readVersion(binary, run, timeoutMs, signal)
    const serverKey = join(directory, 'probe-server.private.json')
    const clientKey = join(directory, 'probe-client.private.json')

    const serverKeygen = await run({
      program: binary,
      args: ['genkey', `--key=${tailcatKeyPathArgument(serverKey)}`, `--region=${PROBE_REGION_ID}`],
      timeoutMs,
      signal
    })
    signal?.throwIfAborted()
    const token = serverKeygen.stdout.trim().split(/\r?\n/).pop() ?? ''
    if (serverKeygen.code !== 0 || !existsSync(serverKey) || !token.startsWith('tc')) {
      return failure(
        version,
        `tailcat genkey did not produce a server key and token: ${detail(serverKeygen)}`
      )
    }

    const parsed = await run({ program: binary, args: ['parse', token], timeoutMs, signal })
    signal?.throwIfAborted()
    if (parsed.code !== 0 || !parsed.stdout.includes('"ServerPublic"')) {
      return failure(version, `tailcat parse did not decode its own token: ${detail(parsed)}`)
    }

    const clientKeygen = await run({
      program: binary,
      args: ['genkey', '--client', `--key=${tailcatKeyPathArgument(clientKey)}`],
      timeoutMs,
      signal
    })
    signal?.throwIfAborted()
    if (clientKeygen.code !== 0 || !existsSync(clientKey)) {
      return failure(version, `tailcat genkey --client failed: ${detail(clientKeygen)}`)
    }

    const socks = await probeSocksReadiness(binary, clientKey, spawn, timeoutMs, signal)
    if (socks !== null) {
      return failure(version, socks)
    }
    return { ok: true, version }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return failure(version, error instanceof Error ? error.message : String(error))
  } finally {
    if (ownsDirectory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

async function readVersion(
  binary: string,
  run: TailcatProcessRunner,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const result = await run({ program: binary, args: ['version'], timeoutMs, signal })
    signal?.throwIfAborted()
    const version = result.stdout.trim().split(/\r?\n/)[0] ?? ''
    return result.code === 0 && version ? version : null
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

function probeSocksReadiness(
  binary: string,
  clientKey: string,
  spawn: TailcatProcessSpawner,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  const child = spawn({
    program: binary,
    args: [`--key=${tailcatKeyPathArgument(clientKey)}`, 'socks', '--listen=127.0.0.1:0'],
    timeoutMs: null
  })
  guardChildStreams(child)
  child.stdout.resume()
  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const stderrTail: string[] = []
    const detach = onProcessOutputLines(child.stderr, (line) => {
      stderrTail.push(line)
      if (stderrTail.length > 5) {
        stderrTail.shift()
      }
      if (SOCKS_LISTEN_PATTERN.test(line)) {
        finish(null)
      }
    })
    const timer = setTimeout(() => {
      finish(`tailcat socks did not report a listener within ${timeoutMs}ms`)
    }, timeoutMs)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        `tailcat socks exited (${signal ?? code ?? 'unknown'}) before reporting a listener: ${stderrTail.join(' | ')}`
      )
    }
    const onAbort = (): void =>
      finish(null, signal?.reason ?? new Error('Tailcat compatibility probe was cancelled'))
    const finish = (reason: string | null, error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      detach()
      child.off('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      void terminateChild(child, 2_000).then(() => {
        if (error) {
          reject(error)
        } else {
          resolve(reason)
        }
      }, reject)
    }
    child.on('exit', onExit)
    child.on('error', (error) => finish(error.message))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

function detail(result: { code: number | null; stderr: string; stdout: string }): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 300)
}

function failure(version: string | null, reason: string): TailcatCompatibility {
  return { ok: false, version, reason: `${reason}. ${TAILCAT_INCOMPATIBLE_HINT}` }
}
