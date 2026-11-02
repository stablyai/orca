import { runProcessSync } from '@orca/process-host'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'
import {
  clearServeAbortPark,
  isServeAbortParkActive,
  readServeAbortPark,
  SERVE_ABORT_PARK_EXIT_CODE,
  writeServeAbortPark
} from '../../shared/serve-abort-park'
import { tryReadMetadata } from './metadata'
import { probeRuntimeListener, type RuntimeListenerProbe } from './runtime-listener-probe'
import { getCliStatus } from './status'
import { RuntimeClientError } from './types'

/** Who holds this profile, in the execution-boundary vocabulary: only `absent` lets serve start. */
export type ServeProfileVerdict =
  | { verdict: 'live'; evidence: 'rpc' | 'listening'; pid: number | null }
  | { verdict: 'unverifiable'; reason: 'endpoint-held' | 'access-denied'; pid: number | null }
  | { verdict: 'absent' }

/** The part of `orca status` the verdict reads. */
type ServeProfileStatus = {
  result: { app: { pid?: number | null }; runtime: { reachable: boolean } }
}

type PreflightDeps = {
  readMetadata: (userDataPath: string) => RuntimeMetadata | null
  readStatus: (userDataPath: string) => Promise<ServeProfileStatus>
  probeListener: (metadata: RuntimeMetadata) => Promise<RuntimeListenerProbe>
}

const DEFAULT_DEPS: PreflightDeps = {
  readMetadata: tryReadMetadata,
  readStatus: getCliStatus,
  probeListener: probeRuntimeListener
}

/**
 * Why before the exec: macOS aborts a second Electron main inside `_RegisterApplication`, before
 * any Orca JavaScript can apply the one-Orca-per-profile rule, so the CLI must decide first.
 * Only a definitive refusal frees the profile; a recorded pid alone proves nothing (pids recycle).
 */
export async function decideServeProfileVerdict(
  userDataPath: string,
  metadata: RuntimeMetadata,
  deps: PreflightDeps = DEFAULT_DEPS
): Promise<ServeProfileVerdict> {
  let status: ServeProfileStatus
  try {
    status = await deps.readStatus(userDataPath)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'runtime_access_denied') {
      return { verdict: 'unverifiable', reason: 'access-denied', pid: metadata.pid ?? null }
    }
    throw error
  }
  const pid = status.result.app.pid ?? metadata.pid ?? null
  if (status.result.runtime.reachable) {
    return { verdict: 'live', evidence: 'rpc', pid }
  }
  const probe = await deps.probeListener(metadata)
  if (probe === 'accepting') {
    return { verdict: 'live', evidence: 'listening', pid }
  }
  return probe === 'not-listening'
    ? { verdict: 'absent' }
    : { verdict: 'unverifiable', reason: 'endpoint-held', pid }
}

export function serveProfileRefusalMessage(
  verdict: Exclude<ServeProfileVerdict, { verdict: 'absent' }>
): string {
  const who = verdict.pid === null ? 'another process' : `pid ${verdict.pid}`
  const lead = `[serve] Orca is already running for this userData profile as ${who}`
  if (verdict.verdict === 'live') {
    return verdict.evidence === 'rpc'
      ? `${lead}; not starting a second process. Run \`orca status\` to inspect it, or stop it before serving again.`
      : `${lead}: its socket accepts connections but it is not answering \`orca status\` yet; not starting a second process. Wait for it to finish starting, or stop it before serving again.`
  }
  if (verdict.reason === 'access-denied') {
    return `${lead}: it refused this CLI's credentials, so it cannot be shown to be stopped; not starting a second process. Stop it, or run this command as the user that started it.`
  }
  return `${lead}: its socket neither accepted nor refused a connection, so this profile cannot be shown to be free; not starting a second process. Stop that process, or delete orca-runtime.json from this profile if nothing owns it.`
}

function refusalEnvelope(code: string, message: string, data: unknown): RuntimeRpcFailure {
  return { id: 'local', ok: false, error: { code, message, data }, _meta: { runtimeId: null } }
}

/** Why: `--json` callers parse stdout; recipe stdout is a strict schema channel, so it gets stderr. */
function writeRefusal(
  args: { json?: boolean; recipeJson?: boolean },
  envelope: RuntimeRpcFailure
): void {
  if (args.json === true && args.recipeJson !== true) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`)
  } else {
    process.stderr.write(`${envelope.error.message}\n`)
  }
}

/** What separates "this environment" from another: launchd session type, SSH, app sandbox. */
export function serveEnvironmentFingerprint(env: NodeJS.ProcessEnv = process.env): string {
  let manager = 'unknown'
  try {
    const result = runProcessSync({
      program: 'launchctl',
      args: ['managername'],
      timeoutMs: 2_000
    })
    manager = result.code === 0 ? result.stdout.trim() || 'unknown' : 'unknown'
  } catch {
    manager = 'unknown'
  }
  return `${manager}|ssh=${env.SSH_CONNECTION ? 1 : 0}|sandbox=${env.APP_SANDBOX_CONTAINER_ID ? 1 : 0}`
}

export type ElectronServePreflightArgs = {
  json?: boolean
  recipeJson?: boolean
  force?: boolean
}

/**
 * Null means start now. A number is the exit code of a refusal already reported. Synchronous
 * when nothing has ever published this profile, so a fresh launch keeps its old timing.
 */
export function preflightElectronServe(
  args: ElectronServePreflightArgs,
  userDataPath: string,
  options: {
    platform?: NodeJS.Platform
    now?: number
    fingerprint?: () => string
    deps?: PreflightDeps
  } = {}
): number | null | Promise<number | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    if (args.force) {
      clearServeAbortPark(userDataPath)
    } else {
      const park = readServeAbortPark(userDataPath)
      const fingerprint = options.fingerprint ?? serveEnvironmentFingerprint
      if (park && isServeAbortParkActive(park, fingerprint(), options.now ?? Date.now())) {
        const minutes = Math.max(1, Math.round(((options.now ?? Date.now()) - park.at) / 60_000))
        const message = `[serve] Not starting: \`orca serve\` aborted at macOS startup in this environment ${minutes} min ago, and retrying here cannot help. ${park.diagnostic} Run it with --force to try anyway.`
        writeRefusal(args, refusalEnvelope('runtime_serve_parked', message, { at: park.at }))
        return SERVE_ABORT_PARK_EXIT_CODE
      }
    }
  }
  return refuseIfProfileServed(args, userDataPath, options.deps)
}

/** The runtime-neutral half: refuse with exit 3 while another Orca serves or may serve this profile. */
export function refuseIfProfileServed(
  args: ElectronServePreflightArgs,
  userDataPath: string,
  deps: PreflightDeps = DEFAULT_DEPS
): null | Promise<number | null> {
  const metadata = deps.readMetadata(userDataPath)
  if (!metadata) {
    return null
  }
  return decideServeProfileVerdict(userDataPath, metadata, deps).then((verdict) => {
    if (verdict.verdict === 'absent') {
      return null
    }
    const message = serveProfileRefusalMessage(verdict)
    writeRefusal(
      args,
      refusalEnvelope('runtime_serve_already_running', message, {
        verdict: verdict.verdict,
        pid: verdict.pid
      })
    )
    return SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
  })
}

/** Remembers a macOS startup abort so a later, separate `orca serve` here refuses before exec. */
export function recordElectronServeStartupAbort(
  userDataPath: string,
  diagnostic: string,
  options: { now?: number; fingerprint?: () => string } = {}
): void {
  writeServeAbortPark(userDataPath, {
    schemaVersion: 1,
    verdict: 'environment_abort',
    at: options.now ?? Date.now(),
    envFingerprint: (options.fingerprint ?? serveEnvironmentFingerprint)(),
    diagnostic
  })
}
