import { spawn } from 'child_process'
import type { SystemResolverHealth } from '../daemon/types'

const MAC_RESOLVER_CHECK_TIMEOUT_MS = 1_500
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

export async function readCurrentProcessMacSystemResolverHealth(): Promise<SystemResolverHealth> {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(classifyMacSystemResolverHealth(`${stdout}\n${stderr}`))
    }
    const child = spawn('/usr/sbin/scutil', ['--dns'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      child.kill()
      // Why: this runs inside the daemon request path, so the timeout must
      // cap the RPC even if scutil is slow to exit after SIGTERM.
      finish()
    }, MAC_RESOLVER_CHECK_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', finish)
    child.on('close', finish)
  })
}
