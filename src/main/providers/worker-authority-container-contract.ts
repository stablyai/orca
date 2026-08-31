export const WORKER_AUTHORITY_DOCKER_PATH = '/usr/local/bin/docker'

export const WORKER_AUTHORITY_POLICY_LABEL = 'orca.worker-authority.policy'
export const WORKER_AUTHORITY_ROOT_LABEL = 'orca.worker-authority.root'
export const WORKER_AUTHORITY_NONCE_LABEL = 'orca.worker-authority.nonce'

export const WORKER_AUTHORITY_ROOT_PREFIX = 'orca-worker-authority-'
export const WORKER_AUTHORITY_OWNERSHIP_FILE = 'ownership-nonce'
export const WORKER_AUTHORITY_CID_FILE = 'container.cid'
export const WORKER_AUTHORITY_DAEMON_OWNER_FILE = 'daemon-owner.json'

export type WorkerAuthorityDaemonOwner = {
  schemaVersion: 'worker_authority_daemon_owner/1'
  pid: number
  startedAtMs: number
  launchNonce: string
  socketPath: string
  tokenPath: string
  linuxStartTicks?: string
  bootId?: string
}
