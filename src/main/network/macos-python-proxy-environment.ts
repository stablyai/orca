import { isIP } from 'node:net'
import { runProcess } from '@orca/process-host'

type PythonSystemProxy = {
  proxies: Readonly<Record<string, string>>
  bypass: readonly string[]
}

let pending: Promise<PythonSystemProxy | null> | null = null

/** Read on the execution host, never through the desktop's Chromium proxy session. */
export function readMacosPythonProxyEnvironment(): Promise<PythonSystemProxy | null> {
  if (process.platform !== 'darwin') {
    return Promise.resolve(null)
  }
  // Share launch bursts, but reread after settlement so changed system settings take effect.
  return (pending ??= readSystemProxy().finally(() => {
    pending = null
  }))
}

async function readSystemProxy(): Promise<PythonSystemProxy | null> {
  try {
    const result = await runProcess({
      program: '/usr/sbin/scutil',
      args: ['--proxy'],
      timeoutMs: 3000,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.signal || result.timedOut || result.outputTruncated) {
      return null
    }
    return parseSystemProxy(result.stdout)
  } catch {
    return null
  }
}

function parseSystemProxy(output: string): PythonSystemProxy | null {
  const fields = new Map<string, string>()
  const exceptions: string[] = []
  let depth = 0
  let inExceptions = false
  let opened = false
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    if (!opened) {
      if (trimmed !== '<dictionary> {') {
        return null
      }
      opened = true
      depth = 1
      continue
    }
    if (trimmed === '}') {
      if (--depth < 0) {
        return null
      }
      if (depth === 1) {
        inExceptions = false
      }
      continue
    }
    if (depth === 0) {
      return null
    }
    const entry = /^\s+([^ ]+) : (.*)$/.exec(line)
    if (!entry) {
      return null
    }
    const [, key, value] = entry
    if (depth === 1) {
      fields.set(key, value)
      inExceptions = key === 'ExceptionsList' && value === '<array> {'
    } else if (depth === 2 && inExceptions) {
      exceptions.push(value)
    }
    if (value === '<dictionary> {' || value === '<array> {') {
      depth++
    }
  }
  if (!opened || depth !== 0) {
    return null
  }
  // Python ignores PAC; an environment mapping cannot preserve arbitrary PAC policies.
  if (
    Number(fields.get('ProxyAutoConfigEnable') ?? 0) !== 0 ||
    Number(fields.get('ProxyAutoDiscoveryEnable') ?? 0) !== 0
  ) {
    return null
  }
  if (fields.has('ExceptionsList') && fields.get('ExceptionsList') !== '<array> {') {
    return null
  }
  const bypass: string[] = []
  for (const entry of exceptions) {
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(entry.toLowerCase())) {
      continue
    }
    if (isIP(entry)) {
      bypass.push(entry)
    } else if (entry === '*.local') {
      bypass.push('.local')
    } else if (!isPrivateIpv4Prefix(entry)) {
      // NO_PROXY widens domain wildcards to their apex and exact hostnames to suffixes.
      return null
    }
  }
  const proxies: Record<string, string> = {}
  for (const [scheme, key] of [
    ['http', 'HTTP'],
    ['https', 'HTTPS'],
    ['ftp', 'FTP'],
    ['gopher', 'Gopher'],
    ['socks', 'SOCKS']
  ]) {
    const enabled = Number(fields.get(`${key}Enable`) ?? 0)
    if (!Number.isFinite(enabled)) {
      return null
    }
    if (!enabled) {
      continue
    }
    const host = fields.get(`${key}Proxy`)
    const port = fields.get(`${key}Port`)
    if (!host || (port !== undefined && !/^\d+$/.test(port))) {
      return null
    }
    // CPython's _scproxy uses http:// even for the SOCKS dictionary entry.
    proxies[scheme] = `http://${host}${port === undefined ? '' : `:${port}`}`
  }
  // Private/link-local ranges and exclude-simple are omitted; no exact NO_PROXY equivalent exists.
  return Object.keys(proxies).length ? { proxies, bypass } : null
}

function isPrivateIpv4Prefix(value: string): boolean {
  const match = /^(\d+(?:\.\d+){0,3})(?:\/(\d+))?$/.exec(value)
  if (!match) {
    return false
  }
  const parts = match[1].split('.').map(Number)
  if (parts.some((part) => part > 255)) {
    return false
  }
  const prefix = match[2] === undefined ? parts.length * 8 : Number(match[2])
  if (prefix > 32) {
    return false
  }
  while (parts.length < 4) {
    parts.push(0)
  }
  const address = parts.reduce((total, part) => total * 256 + part, 0)
  const size = 2 ** (32 - prefix)
  const start = Math.floor(address / size) * size
  const end = start + size - 1
  return [
    [0x0a000000, 0x0affffff],
    [0x7f000000, 0x7fffffff],
    [0xa9fe0000, 0xa9feffff],
    [0xac100000, 0xac1fffff],
    [0xc0a80000, 0xc0a8ffff]
  ].some(([first, last]) => start >= first && end <= last)
}
