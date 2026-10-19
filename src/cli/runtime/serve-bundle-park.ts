import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ackFileName,
  acksDir,
  bundleCoordinationDir,
  bundleInfoPlistPath,
  decideServeParkHold,
  formatBundleIdentity,
  isProcessAlive,
  isServeSupervisorLabel,
  macCoordinationRoot,
  parkRecordPath,
  parseServeParkRecord,
  supervisorsDir,
  SERVE_COORDINATION_PROTOCOL,
  type ServeParkRecord,
  type ServeSupervisorRegistration
} from '../../shared/serve-bundle-coordination'
import { homedir } from 'node:os'

/** The supervisor's half of the desktop-install park protocol. */
export type ServeBundlePark = {
  heartbeat: (childPid: number | null) => void
  unregister: () => void
  /** A park the installer is asking for now, or null. */
  pendingPark: () => { attemptId: string } | null
  ack: (attemptId: string) => void
  /** True while the shared record says this bundle must stay stopped. */
  holds: () => boolean
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

function readParkRecord(dir: string): ServeParkRecord | null {
  try {
    return parseServeParkRecord(JSON.parse(readFileSync(parkRecordPath(dir), 'utf8')))
  } catch {
    return null
  }
}

function readBundleIdentity(bundlePath: string): string {
  try {
    return formatBundleIdentity(statSync(bundleInfoPlistPath(bundlePath)))
  } catch {
    return formatBundleIdentity(null)
  }
}

/**
 * Only a launchd service whose label `orca serve service install` wrote takes part: the installer
 * stops a server only when a service manager it can name keeps the supervisor running. Everyone
 * else keeps today's refusal.
 */
export function openServeBundlePark(input: {
  executable: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  userDataRoot?: string
  now?: () => number
}): ServeBundlePark | null {
  const env = input.env ?? process.env
  const label = env.XPC_SERVICE_NAME
  if ((input.platform ?? process.platform) !== 'darwin' || !isServeSupervisorLabel(label)) {
    return null
  }
  const bundle = dirname(dirname(dirname(input.executable)))
  if (!bundle.endsWith('.app')) {
    return null
  }
  let realBundle: string
  try {
    realBundle = realpathSync(bundle)
  } catch {
    return null
  }
  const now = input.now ?? Date.now
  const dir = bundleCoordinationDir(
    realBundle,
    input.userDataRoot ?? macCoordinationRoot(homedir())
  )
  const registrationPath = join(supervisorsDir(dir), `${process.pid}.json`)
  return {
    heartbeat: (childPid) => {
      const registration: ServeSupervisorRegistration = {
        protocol: SERVE_COORDINATION_PROTOCOL,
        pid: process.pid,
        childPid,
        heartbeatAt: now(),
        label
      }
      try {
        writeJsonAtomic(registrationPath, registration)
      } catch {
        // Unregistered is safe: the installer then refuses, exactly as before this protocol.
      }
    },
    unregister: () => {
      try {
        rmSync(registrationPath, { force: true })
      } catch {
        // A leftover registration goes stale on its own heartbeat.
      }
    },
    pendingPark: () => {
      const record = readParkRecord(dir)
      return record?.phase === 'park' &&
        record.supervisorPids.includes(process.pid) &&
        decideServeParkHold(record, {
          now: now(),
          installerAlive: isProcessAlive(record.installerPid),
          bundleNow: record.bundleBefore
        }) === 'hold'
        ? { attemptId: record.attemptId }
        : null
    },
    ack: (attemptId) => {
      try {
        writeJsonAtomic(join(acksDir(dir), ackFileName(attemptId, process.pid)), {
          pid: process.pid,
          at: now()
        })
      } catch {
        // No ack means the installer gives up and the park ends; never a stuck service.
      }
    },
    holds: () => {
      const record = readParkRecord(dir)
      return (
        decideServeParkHold(record, {
          now: now(),
          installerAlive: record ? isProcessAlive(record.installerPid) : false,
          bundleNow: readBundleIdentity(realBundle)
        }) === 'hold'
      )
    }
  }
}
