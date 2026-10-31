import { readdirSync, readFileSync } from 'node:fs'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { inspectDaemonProcessIdentity } from './daemon-pid-identity'
import { hasErrorCode } from './daemon-process-inspection'
import { shortDaemonSocketDir } from './daemon-socket-endpoint-path'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'

const PID_FILE_PATTERN = /^daemon-v(\d+)\.pid$/
// Pid records can be mid-repair; token and socket names still mark a generation.
const GENERATION_ARTIFACT_PATTERN = /^daemon-v(\d+)\.(?:pid|token|sock)$/

function namedProtocols(names: readonly string[], pattern: RegExp): number[] {
  return names
    .map((name) => Number(pattern.exec(name)?.[1]))
    .filter((version) => Number.isSafeInteger(version) && version > 0)
}

/** Names in a dir; a missing dir has none, any other failure is null. */
function readDirNames(dir: string): string[] | null {
  try {
    return readdirSync(dir)
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? [] : null
  }
}

/** Protocols with a pid record in this runtime dir, including ones this build cannot speak. */
export function listDaemonPidFileProtocols(runtimeDir: string): number[] {
  try {
    return namedProtocols(readdirSync(runtimeDir), PID_FILE_PATTERN)
  } catch {
    // Discovery errors leave no known pid records.
    return []
  }
}

async function probeDaemonEndpoint(
  socketPath: string
): Promise<Awaited<ReturnType<typeof probeSocketConnect>>> {
  const outcome = await probeSocketConnect(socketPath)
  if (outcome !== 'unknown') {
    return outcome
  }
  // A stalled main loop can fire timeout before the dead socket's refusal arrives.
  await new Promise<void>((resolve) => setImmediate(resolve))
  return probeSocketConnect(socketPath)
}

/** Inspect one daemon generation's PID and endpoint without mutating its files. */
export async function classifyDaemonGeneration(
  runtimeDir: string,
  protocolVersion: number
): Promise<ProcessLivenessVerdict['status']> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const byEndpoint = async (): Promise<ProcessLivenessVerdict['status']> =>
    endpointIsProvenDead(await probeDaemonEndpoint(socketPath)) ? 'exited' : 'unverifiable'
  let contents: string
  try {
    contents = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') ? 'exited' : byEndpoint()
  }
  const parsed = parseDaemonPidFile(contents)
  // An empty legacy record parses as PID 0, which is not a daemon PID.
  if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return byEndpoint()
  }
  const identity = await inspectDaemonProcessIdentity(
    parsed.pid,
    socketPath,
    getDaemonTokenPath(runtimeDir, protocolVersion),
    parsed.startedAtMs
  )
  if (identity === 'match') {
    return 'live'
  }
  return identity === 'mismatch' ? 'exited' : byEndpoint()
}

/** Every daemon generation alive in this runtime dir, sorted; null when any one cannot be ruled in or out. */
export async function listLiveDaemonProtocols(
  runtimeDir: string,
  knownProtocols: readonly number[]
): Promise<number[] | null> {
  // Unix sockets too long for the runtime dir live in a relocated one.
  const uid = process.getuid?.()
  const dirs = [runtimeDir, ...(uid === undefined ? [] : [shortDaemonSocketDir(runtimeDir, uid)])]
  const protocols = new Set(knownProtocols)
  for (const dir of dirs) {
    const names = readDirNames(dir)
    if (!names) {
      // An unreadable dir could hide a generation this build does not know to probe.
      return null
    }
    namedProtocols(names, GENERATION_ARTIFACT_PATTERN).forEach((p) => protocols.add(p))
  }
  const live: number[] = []
  for (const protocol of [...protocols].sort((a, b) => a - b)) {
    // Legacy discovery attaches any answering endpoint, whatever its pid record says.
    const endpoint = await probeDaemonEndpoint(getDaemonSocketPath(runtimeDir, protocol))
    if (endpoint === 'connected') {
      live.push(protocol)
    } else if (
      !endpointIsProvenDead(endpoint) ||
      (await classifyDaemonGeneration(runtimeDir, protocol)) !== 'exited'
    ) {
      return null
    }
  }
  return live
}
