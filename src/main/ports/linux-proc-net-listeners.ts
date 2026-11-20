import { getProcessOutputFields } from '../../shared/process-observation/process-output-field-scanner'
import { parseProcAddress } from './local-workspace-port-address'

export type ProcNetListener = { host: string; port: number; inode: number; uid: number }

// Login accounts (local or directory) get uids from UID_MIN up; root and system services sit below.
const FIRST_LOGIN_UID = 1000
const SYSTEMD_DYNAMIC_UIDS = { first: 61184, last: 65519 }
const NOBODY_UID = 65534

function isAnotherLoginUsersListener(uid: number, ownUid: number | undefined): boolean {
  // Root sees every account's processes, as root lsof does on macOS.
  if (ownUid === undefined || ownUid === 0 || uid === ownUid) {
    return false
  }
  const isServiceAccount =
    uid < FIRST_LOGIN_UID ||
    uid === NOBODY_UID ||
    (uid >= SYSTEMD_DYNAMIC_UIDS.first && uid <= SYSTEMD_DYNAMIC_UIDS.last)
  return !isServiceAccount
}

/** Shared hosts list every user's sockets in /proc/net; keep ours and system services', like non-root lsof on macOS. */
export function parseProcNetTcp(content: string, ownUid: number | undefined): ProcNetListener[] {
  const results: ProcNetListener[] = []
  const lines = content.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const fields = getProcessOutputFields(lines[i], 10)
    if (fields.length < 10 || fields[3] !== '0A') {
      continue
    }
    const parsed = parseProcAddress(fields[1])
    const uid = Number.parseInt(fields[7], 10)
    const inode = Number.parseInt(fields[9], 10)
    if (
      !parsed ||
      !Number.isFinite(inode) ||
      inode === 0 ||
      isAnotherLoginUsersListener(uid, ownUid)
    ) {
      continue
    }
    results.push({ ...parsed, inode, uid })
  }
  return results
}
