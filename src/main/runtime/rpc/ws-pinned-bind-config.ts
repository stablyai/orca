import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import {
  WS_BIND_HOST_LOOPBACK,
  type OrcaRuntimeRpcServerOptions
} from '../runtime-rpc/runtime-rpc-pairing-types'

// Why a file in the data folder and not an env var or flag: a desktop app relaunched from the Dock, Start
// menu, or an auto-update loses both, and an unpinned relaunch goes back to the default policy — which
// binds 0.0.0.0 once any network device has connected (STA-2370). Docs: docs/site/content/docs/remote-servers.mdx.
export const WS_PINNED_BIND_CONFIG_FILE = 'runtime-ws-bind.json'

export type WsPinnedBindConfig =
  | { status: 'unset' }
  | { status: 'pinned'; host: string; port: number }
  | { status: 'invalid'; reason: string }

export type WsPinnedBindServerOptions = Pick<
  OrcaRuntimeRpcServerOptions,
  'pinnedBindHost' | 'wsPort' | 'strictWsPort' | 'webSocketConfigError'
>

export function parseWsPinnedBindConfig(raw: string): WsPinnedBindConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'invalid', reason: 'the file is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', reason: 'expected an object like {"host":"127.0.0.1","port":6768}' }
  }
  // Why reject unknown keys: a misspelt "bindHost" would otherwise leave host missing and read as a
  // different mistake than the one the operator made.
  const unknownKey = Object.keys(parsed).find((key) => key !== 'host' && key !== 'port')
  if (unknownKey !== undefined) {
    return { status: 'invalid', reason: `unknown key ${JSON.stringify(unknownKey)}` }
  }
  const host = 'host' in parsed ? parsed.host : undefined
  const port = 'port' in parsed ? parsed.port : undefined
  // Why literal IPs only: listen() resolves a hostname through DNS, so the interface bound would be
  // decided by resolver state the operator cannot see (same rule as orcad --bind).
  // Why loopback only: the pin fronts an operator's own forwarder (Tailscale Serve, SSH -L); a wildcard,
  // LAN, or tailnet address would expose the listener directly. IPv6 is exactly "::1" — zoned, expanded,
  // and IPv4-mapped spellings are rejected, not normalized.
  if (
    typeof host !== 'string' ||
    (host !== '::1' && !(isIP(host) === 4 && host.startsWith('127.')))
  ) {
    return {
      status: 'invalid',
      reason: '"host" must be a loopback IP address: 127.0.0.1 (any 127.x.x.x) or ::1'
    }
  }
  // Why no 0: an OS-assigned port is exactly the relocation this pin exists to forbid.
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return { status: 'invalid', reason: '"port" must be an integer from 1 to 65535' }
  }
  return { status: 'pinned', host, port }
}

export function readWsPinnedBindConfig(userDataPath: string): WsPinnedBindConfig {
  let raw: string
  try {
    raw = readFileSync(join(userDataPath, WS_PINNED_BIND_CONFIG_FILE), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { status: 'unset' }
    }
    return {
      status: 'invalid',
      reason: `the file could not be read (${error instanceof Error ? error.message : String(error)})`
    }
  }
  // Why: Windows PowerShell 5.1 `Set-Content -Encoding UTF8` prefixes a BOM, which JSON.parse rejects.
  return parseWsPinnedBindConfig(raw.startsWith('\uFEFF') ? raw.slice(1) : raw)
}

// Why invalid still pins loopback + strict: an unreadable pin must fail closed — no listener at all — rather
// than fall back to the default policy the operator opted out of.
export function wsPinnedBindServerOptions(config: WsPinnedBindConfig): WsPinnedBindServerOptions {
  switch (config.status) {
    case 'unset':
      return {}
    case 'pinned':
      return { pinnedBindHost: config.host, wsPort: config.port, strictWsPort: true }
    case 'invalid':
      return {
        pinnedBindHost: WS_BIND_HOST_LOOPBACK,
        strictWsPort: true,
        webSocketConfigError: new Error(`Invalid ${WS_PINNED_BIND_CONFIG_FILE}: ${config.reason}`)
      }
  }
}
