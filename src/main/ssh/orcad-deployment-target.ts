import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVER_TARGETS, type ServerTarget } from '../../shared/node-runtime-pin'
import { ORCAD_SERVER_TARGET_FILENAME } from '../../shared/orcad-artifacts'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/** The host answered the libc probe, but with nothing this client recognises. */
export class UnidentifiedHostLibcError extends Error {
  constructor() {
    super('Could not identify the host C library for the bundled Orca runtime')
    this.name = 'UnidentifiedHostLibcError'
  }
}

export function parseOrcadLinuxLibc(output: string): 'glibc' | 'musl' {
  if (/\bmusl\b/i.test(output)) {
    return 'musl'
  }
  if (/\b(?:glibc|GNU libc|GNU C Library)\b/i.test(output)) {
    return 'glibc'
  }
  throw new UnidentifiedHostLibcError()
}

export type GlibcVersion = { major: number; minor: number }

export type OrcadDeploymentTargetFacts = {
  target: ServerTarget
  /** The host's glibc, when the libc probe printed one; null on musl and non-Linux hosts. */
  glibc: GlibcVersion | null
}

/** `ldd --version`'s first line ends in the version; `getconf GNU_LIBC_VERSION` prints `glibc 2.31`. */
export function parseGlibcVersion(output: string): GlibcVersion | null {
  const firstLine = output.split('\n', 1)[0] ?? ''
  const match = /(\d+)\.(\d+)\s*$/.exec(firstLine.trim()) ?? /\bglibc\s+(\d+)\.(\d+)/i.exec(output)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

export async function resolveOrcadDeploymentTarget(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<ServerTarget> {
  return (await resolveOrcadDeploymentTargetFacts(options)).target
}

export async function resolveOrcadDeploymentTargetFacts(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<OrcadDeploymentTargetFacts> {
  const { host } = options
  if (host.os !== 'linux') {
    return { target: `${host.os}-${host.arch}`, glibc: null }
  }
  const exec =
    options.exec ??
    ((command: string) => execCommand(options.conn, command, { signal: options.signal }))
  let output = await exec('ldd --version 2>&1 || true')
  try {
    return linuxTargetFacts(host, output)
  } catch {
    output = await exec(
      'getconf GNU_LIBC_VERSION 2>/dev/null || ' +
        'for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done'
    )
  }
  return linuxTargetFacts(host, output)
}

function linuxTargetFacts(host: RemoteHostPlatform, output: string): OrcadDeploymentTargetFacts {
  const libc = parseOrcadLinuxLibc(output)
  return {
    target: `linux-${host.arch}-${libc}`,
    glibc: libc === 'glibc' ? parseGlibcVersion(output) : null
  }
}

/** The server target an assembled bundle was built for. */
export function readOrcadBundleTarget(localOrcadDir: string): ServerTarget {
  const recorded = readFileSync(join(localOrcadDir, ORCAD_SERVER_TARGET_FILENAME), 'utf8').trim()
  const target = SERVER_TARGETS.find((candidate) => candidate === recorded)
  if (!target) {
    throw new Error(`The orcad bundle names no known server target: ${recorded}`)
  }
  return target
}
