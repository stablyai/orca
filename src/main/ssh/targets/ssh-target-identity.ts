import type { SshTarget } from '../../../shared/ssh-types'

/** Random target ids change on re-add; workspace re-adoption and retirement namespaces must share endpoint identity rules. */
export type SshIdentityFields = Pick<SshTarget, 'configHost' | 'host' | 'port' | 'username'>

function normalizeSshIdentityPart(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

/** Manual adds default configHost to host; only a distinct value represents an alias. */
export function meaningfulSshAlias(fields: SshIdentityFields): string {
  const alias = normalizeSshIdentityPart(fields.configHost)
  return alias && alias !== normalizeSshIdentityPart(fields.host) ? alias : ''
}

/** Host/port/user define the endpoint/account for re-adoption and path ownership. */
export function sshEndpointKey(fields: SshIdentityFields): string {
  return `${normalizeSshIdentityPart(fields.host)}|${fields.port}|${normalizeSshIdentityPart(fields.username)}`
}
