import { createHash } from 'node:crypto'
import type { SshTarget } from '../../shared/ssh-types'

export function fingerprintRuntimeSshTarget(target: SshTarget): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        host: target.host,
        port: target.port,
        username: target.username,
        configHost: target.configHost,
        identityFile: target.identityFile,
        identityAgent: target.identityAgent,
        identitiesOnly: target.identitiesOnly,
        gssapiAuthentication: target.gssapiAuthentication,
        proxyCommand: target.proxyCommand,
        jumpHost: target.jumpHost,
        systemSshConnectionReuse: target.systemSshConnectionReuse,
        systemSshProxyConnectionReuse: target.systemSshProxyConnectionReuse
      })
    )
    .digest('hex')
}
