import type { SshTarget } from '../../shared/ssh-types'

/**
 * Identity of the endpoint an SSH target reaches, independent of the target row.
 *
 * Target ids are random and minted fresh on every re-add, so anything that must survive a
 * remove/re-add (workspace re-adoption, retirement namespaces) has to compare these fields
 * instead. Kept in one place so those consumers cannot drift apart.
 */
export type SshIdentityFields = Pick<SshTarget, 'configHost' | 'host' | 'port' | 'username'>

export function normalizeSshIdentityPart(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

/** An alias only counts as a distinguishing identity when it differs from the host: addTarget
 *  defaults configHost to host, so a manual add carries the hostname there, not a real alias. */
export function meaningfulSshAlias(fields: SshIdentityFields): string {
  const alias = normalizeSshIdentityPart(fields.configHost)
  return alias && alias !== normalizeSshIdentityPart(fields.host) ? alias : ''
}

/** host+port+username — the tuple that decides which machine and account, hence which filesystem,
 *  a target lands on. Two target rows sharing it share every absolute path. */
export function sshEndpointKey(fields: SshIdentityFields): string {
  return `${normalizeSshIdentityPart(fields.host)}|${fields.port}|${normalizeSshIdentityPart(fields.username)}`
}
