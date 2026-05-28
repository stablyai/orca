import { spawnSync } from 'child_process'
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

export function readCurrentProcessMacSystemResolverHealth(): SystemResolverHealth {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }

  const result = spawnSync('/usr/sbin/scutil', ['--dns'], {
    encoding: 'utf8',
    timeout: MAC_RESOLVER_CHECK_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${
    typeof result.stderr === 'string' ? result.stderr : ''
  }`
  return classifyMacSystemResolverHealth(output)
}
