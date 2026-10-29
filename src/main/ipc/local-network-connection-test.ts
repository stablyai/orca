import { execFile, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { isIP } from 'node:net'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type {
  LocalNetworkConnectionTestFailure,
  LocalNetworkConnectionTestResult
} from '../../shared/developer-permissions-types'

const CONNECT_TIMEOUT_MS = 4_000
const CHILD_TIMEOUT_MS = CONNECT_TIMEOUT_MS + 1_000
const CONNECT_SCRIPT = `
const net = require('node:net')
const host = process.argv[1]
const port = Number(process.argv[2])
const socket = net.createConnection({ host, port })
let settled = false
function finish(code) {
  if (settled) return
  settled = true
  if (code) {
    process.stderr.write(code)
    process.exitCode = 1
  }
  socket.destroy()
}
function isLanAddress(address) {
  const normalized = (address || '').toLowerCase().split('%', 1)[0]
  const mapped = normalized.match(/^::ffff:(\\d{1,3}(?:\\.\\d{1,3}){3})$/)?.[1]
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : null)
  if (ipv4) {
    const octets = ipv4.split('.').map(Number)
    return octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254)
  }
  if (net.isIP(normalized) === 6) {
    const first = Number.parseInt(normalized.split(':')[0], 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return false
}
socket.setTimeout(${CONNECT_TIMEOUT_MS})
socket.once('connect', () => finish(isLanAddress(socket.remoteAddress) ? undefined : 'INVALID_TARGET'))
socket.once('timeout', () => finish('ETIMEDOUT'))
socket.once('error', (error) => finish(error.code || 'FAILED'))
`

type ConnectionChildRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
) => unknown

type LocalNetworkConnectionTestOptions = {
  platform?: NodeJS.Platform
  now?: () => number
  runChild?: ConnectionChildRunner
}

function normalizeTargetHost(rawHost: unknown): string | null {
  if (typeof rawHost !== 'string') {
    return null
  }
  const host = rawHost.trim().replace(/^\[|\]$/g, '')
  if (
    !host ||
    host.startsWith('-') ||
    host.length > 253 ||
    /[\s/\\]/.test(host) ||
    host.includes('://') ||
    !/^[a-z0-9.:%_-]+$/i.test(host)
  ) {
    return null
  }
  const addressWithoutZone = host.split('%', 1)[0] ?? host
  const kind = classifyRemotePairingHostname(addressWithoutZone)
  if (isIP(addressWithoutZone) === 0) {
    return kind === 'loopback' ? null : host
  }
  const isLinkLocalIpv4 = addressWithoutZone.startsWith('169.254.')
  return kind === 'lan' || isLinkLocalIpv4 ? host : null
}

function normalizeTargetPort(rawPort: unknown): number | null {
  return typeof rawPort === 'number' &&
    Number.isInteger(rawPort) &&
    rawPort >= 1 &&
    rawPort <= 65_535
    ? rawPort
    : null
}

function failureFromChild(
  error: ExecFileException,
  stderr: string
): LocalNetworkConnectionTestFailure {
  if (error.killed || error.signal) {
    return 'timeout'
  }
  const code = stderr.trim().split(/\s/, 1)[0]
  switch (code) {
    case 'INVALID_TARGET':
      return 'invalid-target'
    case 'ETIMEDOUT':
      return 'timeout'
    case 'ECONNREFUSED':
      return 'refused'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'unreachable'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'unresolved'
    default:
      return 'failed'
  }
}

export function testLocalNetworkConnection(
  args: { host?: unknown; port?: unknown },
  options: LocalNetworkConnectionTestOptions = {}
): Promise<LocalNetworkConnectionTestResult> {
  const testedAt = (options.now ?? Date.now)()
  const host = normalizeTargetHost(args.host)
  const port = normalizeTargetPort(args.port)
  if (!host || !port) {
    return Promise.resolve({
      ok: false,
      host: typeof args.host === 'string' ? args.host.trim() : '',
      port: typeof args.port === 'number' ? args.port : 0,
      testedAt,
      failure: 'invalid-target'
    })
  }
  if ((options.platform ?? process.platform) !== 'darwin') {
    return Promise.resolve({ ok: false, host, port, testedAt, failure: 'unsupported' })
  }

  const runChild = options.runChild ?? (execFile as ConnectionChildRunner)
  return new Promise((resolve) => {
    runChild(
      process.execPath,
      ['-e', CONNECT_SCRIPT, host, String(port)],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, host, port, testedAt })
          return
        }
        resolve({
          ok: false,
          host,
          port,
          testedAt,
          failure: failureFromChild(error, stderr)
        })
      }
    )
  })
}
