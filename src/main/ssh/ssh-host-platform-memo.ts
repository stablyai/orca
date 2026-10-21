/**
 * The platform each SSH host last reported this app session, so connect telemetry can name it
 * without a probe of its own. Keyed by the local target id, which never leaves this process.
 */
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import type { RemoteHostPlatform } from './ssh-remote-platform'

export type SshHostPlatformFacts = {
  os: RemoteHostPlatform['os']
  arch: RemoteHostPlatform['arch']
  libc: 'glibc' | 'musl' | 'none' | 'unknown'
}

const known = new Map<string, SshHostPlatformFacts>()

export function sshHostLibc(
  os: RemoteHostPlatform['os'],
  target: NodeRuntimeTarget | null
): SshHostPlatformFacts['libc'] {
  if (os !== 'linux') {
    return 'none'
  }
  if (!target) {
    return 'unknown'
  }
  return target.endsWith('-musl') ? 'musl' : 'glibc'
}

export function rememberSshHostPlatform(
  targetId: string,
  host: RemoteHostPlatform,
  target: NodeRuntimeTarget | null
): void {
  const libc = sshHostLibc(host.os, target)
  const previous = known.get(targetId)
  // A libc probe that did not run must not erase one that did.
  known.set(targetId, {
    os: host.os,
    arch: host.arch,
    libc: libc === 'unknown' && previous ? previous.libc : libc
  })
}

export function knownSshHostPlatform(targetId: string): SshHostPlatformFacts | null {
  return known.get(targetId) ?? null
}

export function resetSshHostPlatformMemoForTests(): void {
  known.clear()
}
