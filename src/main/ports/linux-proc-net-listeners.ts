import { parseProcAddress } from './local-workspace-port-address'
import { parseProcNetTcpRows, PROC_NET_TCP_LISTEN_STATE } from './linux-proc-net-tcp-rows'

export type ProcNetListener = { host: string; port: number; inode: number }

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
  for (const row of parseProcNetTcpRows(content)) {
    if (row.state !== PROC_NET_TCP_LISTEN_STATE) {
      continue
    }
    const parsed = parseProcAddress(row.localAddress)
    if (!parsed || row.inode === 0 || isAnotherLoginUsersListener(row.uid, ownUid)) {
      continue
    }
    results.push({ ...parsed, inode: row.inode })
  }
  return results
}
