import { spawn } from 'node:child_process'
import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'
import type { SystemResolverHealth } from '../daemon/types'

const MAC_RESOLVER_CHECK_TIMEOUT_MS = 1_500
export const MAC_RESOLVER_OUTPUT_MAX_BYTES = 1024 * 1024
const MAC_NO_DNS_CONFIGURATION_RE = /\bNo DNS configuration available\b/i
const MAC_DNS_CONFIGURATION_RE = /^DNS configuration\b/m
const MAC_NAMESERVER_RE = /nameserver\[\d+\]\s*:/m

export function classifyMacSystemResolverHealth(scutilOutput: string): SystemResolverHealth {
  if (MAC_NO_DNS_CONFIGURATION_RE.test(scutilOutput)) {
    return 'unhealthy'
  }
  if (MAC_DNS_CONFIGURATION_RE.test(scutilOutput) && MAC_NAMESERVER_RE.test(scutilOutput)) {
    return 'healthy'
  }
  return 'unknown'
}

export async function readCurrentProcessMacSystemResolverHealth(
  signal?: AbortSignal
): Promise<SystemResolverHealth> {
  if (process.platform !== 'darwin' || signal?.aborted) {
    return 'unknown'
  }

  return new Promise((resolve) => {
    const stdout = new GrowingByteBuffer()
    const stderr = new GrowingByteBuffer()
    let outputBytes = 0
    let outputLimitExceeded = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const child = spawn('/usr/sbin/scutil', ['--dns'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const retainOutput = (target: GrowingByteBuffer, chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      if (bytes.byteLength > MAC_RESOLVER_OUTPUT_MAX_BYTES - outputBytes) {
        outputLimitExceeded = true
        stdout.clear()
        stderr.clear()
        child.kill()
        finish()
        return
      }
      target.append(bytes)
      outputBytes += bytes.byteLength
    }
    const onStdoutData = (chunk: Buffer | string): void => {
      retainOutput(stdout, chunk)
    }
    const onStderrData = (chunk: Buffer | string): void => {
      retainOutput(stderr, chunk)
    }
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish()
    }
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      child.stdout.off('data', onStdoutData)
      child.stderr.off('data', onStderrData)
      child.off('error', finish)
      child.off('close', finish)
      signal?.removeEventListener('abort', onAbort)
      resolve(
        outputLimitExceeded
          ? 'unknown'
          : classifyMacSystemResolverHealth(`${stdout.takeString()}\n${stderr.takeString()}`)
      )
    }
    timer = setTimeout(() => {
      child.kill()
      // Why: this runs inside the daemon request path, so the timeout must
      // cap the RPC even if scutil is slow to exit after SIGTERM.
      finish()
    }, MAC_RESOLVER_CHECK_TIMEOUT_MS)
    child.stdout.on('data', onStdoutData)
    child.stderr.on('data', onStderrData)
    child.on('error', finish)
    child.on('close', finish)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
