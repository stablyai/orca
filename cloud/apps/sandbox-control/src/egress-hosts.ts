// Hosts a workspace's own agent tools need beyond the default allowlist — today the remote MCP
// servers the desktop syncs into the sandbox (MCP config sync). The desktop declares them with
// PUT /v1/sandboxes/:id/egress/hosts {hosts}; they persist on the row (every boot re-applies them)
// and a running sandbox's policy is rewritten at once. Public hostnames only: no wildcards, IPs,
// localhost or private suffixes, so the fail-closed allowlist can't be turned into "open".
import { z } from 'zod'
import { egressPolicy, refreshGitCredentials, type LifecycleDeps } from './lifecycle'
import { transition, type SandboxRow } from './store'

export const MAX_USER_HOSTS = 32
const HOST = /^([a-z0-9-]+\.)+[a-z]{2,63}$/
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet']

export const EgressHostsSchema = z
  .object({ hosts: z.array(z.string().min(1).max(253)).max(MAX_USER_HOSTS) })
  .strict()

/** Normalized, deduplicated, sorted; null when any entry is not an acceptable public hostname. */
export function normalizeUserHosts(hosts: readonly string[]): string[] | null {
  const out = new Set<string>()
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase().replace(/\.$/, '')
    if (!HOST.test(host) || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return null
    }
    out.add(host)
  }
  return [...out].sort()
}

export function egressUserHosts(row: Pick<SandboxRow, 'egress_user_hosts'>): string[] {
  return (row.egress_user_hosts ?? '').split(',').filter(Boolean)
}

/** Records the hosts and, for a running sandbox, rewrites its policy now. */
export async function setEgressUserHosts(deps: LifecycleDeps, row: SandboxRow, hosts: string[]): Promise<SandboxRow | null> {
  const value = hosts.join(',') || null
  if (value === row.egress_user_hosts) {
    return row
  }
  const next = await transition(deps.db, row, { egress_user_hosts: value }, deps.now())
  if (!next) {
    return null
  }
  if (next.status === 'running' && next.session_id) {
    // A policy write replaces the whole policy, so the git route is re-minted alongside.
    const git = await refreshGitCredentials(deps, next, next.session_id)
    if (!git) {
      await deps.provider.updateNetworkPolicy(next.session_id, egressPolicy(deps, next))
    }
  }
  // Counts only; hostnames are not secrets but stay out of logs anyway (they can name private tools).
  console.log(JSON.stringify({ event: 'egress_user_hosts_set', sandboxId: row.id, count: hosts.length }))
  return next
}
