import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { hostname } from 'os'
import { arch, platform } from 'process'
import { join } from 'path'
import { TsSidecarClient } from './ts-sidecar-client'
import { tsSidecarBinaryCandidates, tsSidecarStateDir } from './ts-sidecar-paths'
import type { TailscaleTransportResolver } from '../ssh/ssh-tailscale-transport'
import { DEFAULT_WS_PORT } from '../runtime/runtime-rpc'

// Why: a single sidecar process serves all tailnet SSH targets, so the client is
// a lazily-built singleton wired into the SSH connection manager. When no binary
// is present (an unbuilt dev tree), this returns undefined and direct SSH is
// entirely unaffected — tailnet is purely additive.

let client: TsSidecarClient | null = null
let resolved = false

function resolveBinaryPath(): string | null {
  const candidates = tsSidecarBinaryCandidates({
    platform,
    arch,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  })
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function getTailscaleTransport(): TailscaleTransportResolver | undefined {
  if (resolved) {
    return client ?? undefined
  }
  resolved = true

  const binaryPath = resolveBinaryPath()
  if (!binaryPath) {
    return undefined
  }

  const userData = app.getPath('userData')
  const stateDir = tsSidecarStateDir(userData)
  const runtimeDir = join(userData, 'tailnet-runtime')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  client = new TsSidecarClient({
    binaryPath,
    stateDir,
    // Owner-only socket/token keyed by pid so a stale instance can't collide.
    socketPath:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\orca-ts-sidecar-${process.pid}`
        : join(runtimeDir, `ctl-${process.pid}.sock`),
    tokenPath: join(runtimeDir, `token-${process.pid}`),
    token: randomBytes(32).toString('hex'),
    hostname: `orca-${hostname()}`,
    // Expose the WebSocket RPC server over the tailnet so tailnet clients can
    // reach it. The WS server keeps its own 0.0.0.0 bind; this is additive.
    inboundPort: DEFAULT_WS_PORT,
    logger: (message) => console.log(message)
  })
  return client
}

// Exposes the concrete client for status/login IPC. Returns undefined when no
// sidecar binary is present (tailnet feature unavailable in this build).
export function getTailscaleSidecarClient(): TsSidecarClient | undefined {
  getTailscaleTransport()
  return client ?? undefined
}

// The userspace tailnet pairing address (MagicDNS name preferred) when the node
// is running, for the mobile pairing UI. Non-spawning: returns null until the
// sidecar has been started by some other path (e.g. a tailnet SSH connection).
export function getTailnetPairingAddress(): { name: string; address: string } | null {
  const status = getTailscaleSidecarClient()?.peekStatus()
  if (!status || status.state !== 'Running') {
    return null
  }
  const address = status.magicDnsName || status.tailnetIp
  return address ? { name: 'Tailscale (Orca)', address } : null
}

export function disposeTailscaleTransport(): void {
  client?.dispose()
  client = null
  resolved = false
}
