import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

const DISTRIBUTIONS_KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

/** The registration GUID changes when a distro is removed and recreated under the same name. */
export function parseWslDistributionIdentity(output: string, distro: string): string | null {
  let identity: string | null = null
  const matches = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const key = line.trim()
    if (key.startsWith('HKEY_')) {
      const suffix = key.slice(DISTRIBUTIONS_KEY.length)
      identity =
        key.toLowerCase().startsWith(DISTRIBUTIONS_KEY.toLowerCase()) &&
        /^\\\{[0-9a-f-]{36}\}$/i.test(suffix)
          ? suffix.slice(1).toLowerCase()
          : null
      continue
    }
    const value = /^\s*DistributionName\s+REG_SZ\s+(.+?)\s*$/.exec(line)
    if (identity && value?.[1]?.toLowerCase() === distro.toLowerCase()) {
      matches.add(identity)
    }
  }
  return matches.size === 1 ? [...matches][0] : null
}

export async function readWslDistributionIdentity(distro: string): Promise<string> {
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    throw new Error('WSL distribution identity is unavailable on this host')
  }
  const result = await runProcess({
    program: join(process.env.SystemRoot, 'System32', 'reg.exe'),
    args: ['query', DISTRIBUTIONS_KEY, '/s', '/v', 'DistributionName'],
    timeoutMs: 5000,
    maxOutputBytes: 256 * 1024
  })
  const identity =
    result.code === 0 && !result.timedOut
      ? parseWslDistributionIdentity(result.stdout, distro)
      : null
  if (!identity) {
    throw new Error('WSL distribution registration could not be verified')
  }
  return identity
}
