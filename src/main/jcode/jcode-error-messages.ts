// Why: when the jcode child errors or exits non-zero, the chat surfaces the raw
// message (e.g. `spawn /Users/vinny/.cargo/bin/jcode ENOENT`) as a red bubble.
// For a non-technical user that is noise. This maps common failures to a plain-
// language, actionable lead line (Chinese) while keeping the raw detail appended
// in parentheses so a power user can still diagnose.

/** Map a raw jcode/child-process failure to a plain-language, actionable message
 *  for a non-technical user. Leads with the friendly Chinese line; keeps the raw
 *  detail appended (in parentheses). `host` is the remote-exec host when this turn
 *  ran brain-local, used to name the host in connection-failure messages (and to
 *  avoid mislabeling a local failure as a remote one). */
export function friendlyChildError(raw: string, host: string | null): string {
  const detail = raw.trim()
  const lower = detail.toLowerCase()
  // jcode binary missing on PATH / at the pinned cargo path.
  if (lower.includes('enoent') && lower.includes('jcode')) {
    return `找不到 jcode 程序 — 请确认已安装 jcode（${detail}）`
  }
  // Remote host unreachable / SSH transport down (only meaningful for remote turns).
  if (host && isRemoteConnectionFailure(lower)) {
    return `无法连接远程主机 ${host} — 请检查 SSH 连接（${detail}）`
  }
  // Generic non-zero exit with no specific stderr signature.
  return detail || 'jcode 运行出错'
}

/** Heuristic: does this (lowercased) stderr/error text look like an SSH/remote
 *  connection failure rather than an in-agent error? */
function isRemoteConnectionFailure(lower: string): boolean {
  return (
    lower.includes('connection refused') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('no route to host') ||
    lower.includes('could not resolve') ||
    lower.includes('host key') ||
    lower.includes('permission denied') ||
    lower.includes('ssh')
  )
}
