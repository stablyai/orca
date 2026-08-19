/**
 * Where `known_hosts` entries come from for one lookup.
 *
 * Reading the user's real files is the entire migration story — most developers already verified
 * their hosts through `ssh` and `git`. We only read; writing to a file shared with every other SSH
 * tool on the machine is out of scope. See docs/reference/ssh-host-key-verification.md (D1, D2).
 */
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

/**
 * Async because the rejoin below stats the very paths that can hang. Its one caller is already
 * inside a bounded async read, and a synchronous stat there blocked the whole main process on a
 * stalled NFS/SMB mount — worse than the wedged connection the bound was added to prevent.
 */
export async function resolveKnownHostsFiles(
  resolved: SshResolvedConfig | null
): Promise<string[]> {
  const reported = resolved
    ? [...resolved.userKnownHostsFiles, ...resolved.globalKnownHostsFiles]
    : []
  // No `ssh`, a non-zero exit or a timeout must not turn a host the user already verified into
  // first contact, so an empty report falls back rather than reading nothing.
  if (reported.length === 0) {
    return defaultKnownHostsFiles()
  }
  return [
    ...new Set(await rejoinSpaceSplitPaths(reported.filter((path) => path !== EXPLICIT_NONE)))
  ]
}

/**
 * Undo the split when `ssh -G` reported ONE path that happens to contain a space.
 *
 * OpenSSH prints this value unquoted and space-separated, even when the config quoted it — verified
 * against 10.2p1, which echoes `UserKnownHostsFile "/tmp/a b/known_hosts"` back as
 * `userknownhostsfile /tmp/a b/known_hosts`. So the format cannot distinguish one spaced path from
 * two paths, and splitting shreds `C:\Users\John Doe\.ssh\known_hosts` into fragments that resolve
 * to nothing. Every fragment then misses with ENOENT, which reads as "absent" rather than
 * "unreadable" — so the user appears to know no hosts at all, and a changed key that known_hosts
 * would have refused is accepted as first contact instead.
 *
 * The filesystem is the only thing that can disambiguate, so it decides: the longest run of tokens
 * that resolves to a real file is taken as one path, then the scan continues after it. That handles
 * a spaced path sitting alongside ordinary ones, which a whole-list check could not — it would see
 * the ordinary path exist and leave the spaced one in fragments.
 */
async function rejoinSpaceSplitPaths(paths: readonly string[]): Promise<string[]> {
  if (paths.length < 2) {
    return [...paths]
  }
  const rejoined: string[] = []
  let index = 0
  while (index < paths.length) {
    // Longest run first, so a spaced path wins over its own first fragment when both happen to
    // exist. Falls back to the single token when no run resolves, which leaves a genuinely absent
    // path reported as-is rather than inventing one.
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

/**
 * The union across every file. The caller runs `matchKnownHosts` once over the result, so an exact
 * hit in any file wins and a disagreeing entry in another file is not a mismatch.
 */
export async function loadKnownHostsEntries(files: readonly string[]): Promise<KnownHostsEntry[]> {
  return (await loadKnownHostsEvidence(files)).entries
}

export type KnownHostsEvidence = {
  entries: KnownHostsEntry[]
  /**
   * Files that EXIST but could not be read — a permissions problem, a directory, an I/O error.
   *
   * Deliberately not "files that produced no entries": a file that is simply absent is the normal
   * state (ssh creates known_hosts on its own first connect, and most Orca profiles start without
   * one), and it is real evidence that no host is known. A file that exists and refuses to open is
   * the opposite — evidence withheld, so an entry that would have said "this key changed" may be
   * sitting in it. The caller must not record trust while any source is silent that way.
   */
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

/**
 * The name the lookup keys on: `HostKeyAlias` when set, else the resolved hostname, else the host
 * ssh2 dials. Never the Orca label — bastions tunnelled through `localhost:port` depend on the
 * alias, and a label keys on nothing `ssh` ever wrote.
 */
export function resolveKnownHostsLookupHost(
  resolved: SshResolvedConfig | null,
  dialedHost: string
): { host: string; isHostKeyAlias: boolean } {
  // Deliberately NOT `resolved.hostname`: `ssh -G` echoes its own argument back as `hostname` when
  // no Host block matches, which for a manual target is the Orca label. Keying on that consults a
  // name `ssh` never wrote, so the real host's entries are missed entirely and an impersonated
  // host reads as first contact. `dialedHost` is what ssh2 actually connects to, with HostName
  // resolution already applied by buildConnectConfig.
  const alias = resolved?.hostKeyAlias
  // The flag matters as much as the name: ssh looks an alias up WITHOUT the port, so bracketing it
  // would consult a form ssh never writes and, worse, let a stale `[alias]:port` line stop the bare
  // lookup that ssh actually performs.
  return alias ? { host: alias, isHostKeyAlias: true } : { host: dialedHost, isHostKeyAlias: false }
}
