import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export function parseOrcadLinuxLibc(output: string): 'glibc' | 'musl' {
  if (/\bmusl\b/i.test(output)) {
    return 'musl'
  }
  if (/\b(?:glibc|GNU libc|GNU C Library)\b/i.test(output)) {
    return 'glibc'
  }
  throw new Error('Could not identify the host C library for the bundled Orca runtime')
}

export async function resolveOrcadDeploymentTarget(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
}): Promise<OrcadBunTarget> {
  const { host } = options
  if (host.os !== 'linux') {
    return `${host.os}-${host.arch}`
  }
  const output = await execCommand(options.conn, 'ldd --version 2>&1 || true', {
    signal: options.signal
  })
  return `linux-${host.arch}-${parseOrcadLinuxLibc(output)}`
}
