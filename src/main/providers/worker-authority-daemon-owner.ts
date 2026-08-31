import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonReadyIdentity } from '../daemon/daemon-ready-identity'
import {
  WORKER_AUTHORITY_DAEMON_OWNER_FILE,
  WORKER_AUTHORITY_OWNERSHIP_FILE,
  type WorkerAuthorityDaemonOwner
} from './worker-authority-container-contract'

export function createWorkerAuthorityDaemonOwner(args: {
  pid: number
  readyIdentity: DaemonReadyIdentity
  launchNonce: string | undefined
  socketPath: string
  tokenPath: string
}): WorkerAuthorityDaemonOwner | undefined {
  return args.launchNonce
    ? {
        schemaVersion: 'worker_authority_daemon_owner/1',
        pid: args.pid,
        ...args.readyIdentity,
        launchNonce: args.launchNonce,
        socketPath: args.socketPath,
        tokenPath: args.tokenPath
      }
    : undefined
}

export function assertWorkerAuthorityDaemonOwner(owner: WorkerAuthorityDaemonOwner): void {
  if (
    owner.schemaVersion !== 'worker_authority_daemon_owner/1' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !Number.isFinite(owner.startedAtMs) ||
    owner.startedAtMs <= 0 ||
    !owner.launchNonce ||
    !owner.socketPath ||
    !owner.tokenPath ||
    Boolean(owner.linuxStartTicks) !== Boolean(owner.bootId)
  ) {
    throw new Error('worker_authority_isolation_failed')
  }
}

export function createWorkerAuthorityOwnerRecords(args: {
  isolationRoot: string
  owner: WorkerAuthorityDaemonOwner
}): string {
  const ownershipNonce = randomBytes(32).toString('hex')
  writeFileSync(join(args.isolationRoot, WORKER_AUTHORITY_OWNERSHIP_FILE), ownershipNonce, {
    mode: 0o600,
    flag: 'wx'
  })
  writeFileSync(
    join(args.isolationRoot, WORKER_AUTHORITY_DAEMON_OWNER_FILE),
    JSON.stringify(args.owner),
    { mode: 0o600, flag: 'wx' }
  )
  return ownershipNonce
}
