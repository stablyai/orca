/** Read existing SSH trust sources without writing other tools' known_hosts files. */
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshResolvedConfig } from './ssh-g-config-resolution'
import { parseKnownHosts, type KnownHostsEntry } from './ssh-known-hosts'

/** OpenSSH's explicit opt-out for one list; the other list still applies. */
const EXPLICIT_NONE = 'none'

/** Used when `ssh -G` told us nothing — never "no trust source". */
export function defaultKnownHostsFiles(): string[] {
  const home = homedir()
  return [join(home, '.ssh', 'known_hosts'), join(home, '.ssh', 'known_hosts2')]
}

/** Path-rejoin stats must stay async: slow NFS/SMB mounts cannot block main while its caller enforces a read deadline. */
export async function resolveKnownHostsFiles(
  resolved: SshResolvedConfig | null
): Promise<string[]> {
  const reported = resolved
    ? [...resolved.userKnownHostsFiles, ...resolved.globalKnownHostsFiles]
    : []
  // Missing probe output must fall back to normal trust sources, never erase prior verification.
  if (reported.length === 0) {
    return defaultKnownHostsFiles()
  }
  return [
    ...new Set(await rejoinSpaceSplitPaths(reported.filter((path) => path !== EXPLICIT_NONE)))
  ]
}

/** Measured OpenSSH10.2p1 prints space-containing paths unquoted. Rejoin the longest existing token runs, including mixed spaced/ordinary files, or missed trust files can make changed keys look like first contact. */
async function rejoinSpaceSplitPaths(paths: readonly string[]): Promise<string[]> {
  if (paths.length < 2) {
    return [...paths]
  }
  const rejoined: string[] = []
  let index = 0
  while (index < paths.length) {
    // Prefer the longest existing path; preserve an unmatched single token as absent rather than inventing a path.
    let consumed = 0
    for (let end = paths.length; end > index; end -= 1) {
      const candidate = paths.slice(index, end).join(' ')
      if (await exists(candidate)) {
        rejoined.push(candidate)
        consumed = end - index
        break
      }
    }
    if (consumed === 0) {
      rejoined.push(paths[index])
      consumed = 1
    }
    index += consumed
  }
  return rejoined
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

type KnownHostsEvidence = {
  entries: KnownHostsEntry[]
  /** Count existing unreadable sources separately from normal absence; withheld evidence must never become durable new trust. */
  unreadableFileCount: number
}

export async function loadKnownHostsEvidence(
  files: readonly string[]
): Promise<KnownHostsEvidence> {
  const perFile = await Promise.all(
    files.map(async (path) => {
      try {
        return { entries: parseKnownHosts(await readFile(path, 'utf8')), unreadable: false }
      } catch (err) {
        const absent = (err as NodeJS.ErrnoException).code === 'ENOENT'
        return { entries: [] as KnownHostsEntry[], unreadable: !absent }
      }
    })
  )
  return {
    entries: perFile.flatMap((file) => file.entries),
    unreadableFileCount: perFile.filter((file) => file.unreadable).length
  }
}

/** Key by HostKeyAlias or the dialed host after HostName resolution, never the Orca label; bastion loopback connections depend on the alias. */
export function resolveKnownHostsLookupHost(
  resolved: SshResolvedConfig | null,
  dialedHost: string
): { host: string; isHostKeyAlias: boolean } {
  // ssh -G can echo an unknown Orca label as hostname; dialedHost already has real HostName resolution and cannot hide existing trust.
  const alias = resolved?.hostKeyAlias
  // Alias lookups never append ports; a stale bracketed alias could otherwise block the real bare lookup.
  return alias ? { host: alias, isHostKeyAlias: true } : { host: dialedHost, isHostKeyAlias: false }
}
