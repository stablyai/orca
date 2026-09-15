import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS } from '../shared/ssh-types'

const DEFAULT_GRACE_MS = DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS * 1000
const DEFAULT_SOCKET_NAME = 'relay.sock'

export const RELAY_EMPTY_DETACHED_STARTUP_GRACE_MS = parseNonNegativeIntEnv(
  'ORCA_RELAY_EMPTY_STARTUP_GRACE_MS',
  60_000
)
// Why: a relay holding zero PTYs preserves nothing, so an unlimited grace only accumulates idle daemons.
// The env override is test-only — the remote relay is launched over a non-interactive SSH exec channel that carries no client env.
export const RELAY_IDLE_GRACE_MS = parseNonNegativeIntEnv('ORCA_RELAY_IDLE_GRACE_MS', 15 * 60_000)

export type RelayLaunchOptions = {
  graceTimeMs: number
  connectMode: boolean
  detached: boolean
  cliMode: boolean
  sockPath: string
  endpointDir?: string
  logFile?: string
  credentialFile?: string
}

export function parseRelayLaunchOptions(argv: string[]): RelayLaunchOptions {
  const cliMarker = argv.indexOf('--orca-cli', 2)
  const relayArgv = cliMarker === -1 ? argv : argv.slice(0, cliMarker)
  let graceTimeMs = DEFAULT_GRACE_MS
  let connectMode = false
  let detached = false
  const cliMode = cliMarker !== -1
  let sockPath = ''
  let endpointDir: string | undefined
  let logFile: string | undefined
  let credentialFile: string | undefined
  for (let i = 2; i < relayArgv.length; i++) {
    if (relayArgv[i] === '--grace-time' && relayArgv[i + 1]) {
      const parsed = Number.parseInt(relayArgv[i + 1], 10)
      // Why: flag is seconds (internally ms); 0 keeps the relay alive until explicitly terminated for synced workspaces.
      if (!Number.isNaN(parsed) && parsed >= 0) {
        graceTimeMs = parsed * 1000
      }
      i++
    } else if (relayArgv[i] === '--connect') {
      connectMode = true
    } else if (relayArgv[i] === '--detached') {
      detached = true
    } else if (relayArgv[i] === '--sock-path' && relayArgv[i + 1]) {
      sockPath = relayArgv[i + 1]
      i++
    } else if (relayArgv[i] === '--endpoint-dir' && relayArgv[i + 1]) {
      endpointDir = relayArgv[i + 1]
      i++
    } else if (relayArgv[i] === '--log-file' && relayArgv[i + 1]) {
      logFile = relayArgv[i + 1]
      i++
    } else if (relayArgv[i] === '--credential-file' && relayArgv[i + 1]) {
      credentialFile = relayArgv[i + 1]
      i++
    }
  }
  if (!sockPath) {
    sockPath = join(process.cwd(), DEFAULT_SOCKET_NAME)
  }
  return {
    graceTimeMs,
    connectMode,
    detached,
    cliMode,
    sockPath,
    endpointDir,
    logFile,
    credentialFile
  }
}

export function readRelayEndpointCredential(
  credentialFile: string | undefined
): string | undefined {
  if (!credentialFile) {
    return undefined
  }
  const credential = readFileSync(credentialFile, 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) {
    throw new Error('Relay endpoint credential is missing or invalid')
  }
  if (process.platform !== 'win32') {
    chmodSync(credentialFile, 0o600)
  }
  return credential
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
