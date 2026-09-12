import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { RemoteHostPlatform } from './ssh-remote-platform'

const LIBC_MARKER = '__ORCA_LINUX_LIBC__'

export type RemoteLinuxLibc = 'glibc' | 'musl'

export async function detectRemoteOrcadTarget(
  conn: SshConnection,
  host: RemoteHostPlatform,
  options?: { signal?: AbortSignal }
): Promise<OrcadBunTarget> {
  if (host.os !== 'linux') {
    return `${host.os}-${host.arch}`
  }
  const libc = await detectRemoteLinuxLibc(conn, options)
  return `linux-${host.arch}-${libc}`
}

/** Detect the execution host's Linux libc once and fail closed when unknown. */
export async function detectRemoteLinuxLibc(
  conn: SshConnection,
  options?: { signal?: AbortSignal }
): Promise<RemoteLinuxLibc> {
  const output = await execCommand(
    conn,
    remoteLinuxLibcProbeCommand(),
    options?.signal ? { signal: options.signal } : undefined
  )
  const libc = parseRemoteLinuxLibc(output)
  if (!libc) {
    throw new Error(
      'Could not determine whether the remote Linux host uses glibc or musl; refusing to select a native orcad runtime.'
    )
  }
  return libc
}

export function remoteLinuxLibcProbeCommand(): string {
  return [
    'orca_libc=unknown;',
    'orca_getconf=$(getconf GNU_LIBC_VERSION 2>/dev/null || true);',
    'case "$orca_getconf" in *glibc*|*GLIBC*) orca_libc=glibc;; esac;',
    'if [ "$orca_libc" = unknown ]; then',
    'orca_ldd=$(ldd --version 2>&1 || true);',
    'case "$orca_ldd" in *musl*) orca_libc=musl;; *GLIBC*|*glibc*|*GNU?libc*) orca_libc=glibc;; esac;',
    'fi;',
    'if [ "$orca_libc" = unknown ] && ls /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1 >/dev/null 2>&1; then orca_libc=musl; fi;',
    `printf '\\n%s %s\\n' '${LIBC_MARKER}' "$orca_libc"`
  ].join(' ')
}

export function parseRemoteLinuxLibc(output: string): RemoteLinuxLibc | null {
  for (const line of iterateProcessOutputLines(output)) {
    const match = line.trim().match(/^__ORCA_LINUX_LIBC__\s+(glibc|musl|unknown)$/u)
    if (match?.[1] === 'glibc' || match?.[1] === 'musl') {
      return match[1]
    }
  }
  return null
}
