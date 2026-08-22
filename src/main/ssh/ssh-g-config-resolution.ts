import { runProcess } from '../../shared/child-process/run-process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'

export type SshResolvedConfig = {
  hostname: string
  user?: string
  port: number
  identityFile: string[]
  identityAgent?: string
  identitiesOnly: boolean
  forwardAgent: boolean
  /**
   * Effective GSSAPIAuthentication, including distro-wide /etc/ssh defaults — except on the
   * HOME-divergent `-F` path (see sshGArgsForHost), where OpenSSH skips the system config.
   */
  gssapiAuthentication?: boolean
  proxyCommand?: string
  proxyUseFdpass: boolean
  proxyJump?: string
  controlMaster: string
  controlPath?: string
  controlPersist: string
  /** May hold the literal `none`, which OpenSSH prints for an explicit opt-out. */
  userKnownHostsFiles: string[]
  globalKnownHostsFiles: string[]
  strictHostKeyChecking: string
  hostKeyAlias?: string
  hashKnownHosts: boolean
  updateHostKeys: string
}

const SSH_G_TIMEOUT_MS = 5000

function passwdHomeSshConfigPath(): string {
  try {
    return join(userInfo().homedir, '.ssh', 'config')
  } catch {
    return join(homedir(), '.ssh', 'config')
  }
}

export function sshGArgsForHost(host: string): string[] {
  // Why: OpenSSH resolves the default user config via getpwuid, not $HOME.
  // Node's loadUserSshConfig uses os.homedir() (HOME-aware). When those differ
  // (E2E HOME isolation, sandboxes), pass -F so resolve sees the same file the
  // picker listed. Leave the default path alone when HOME matches passwd home
  // so /etc/ssh/ssh_config still participates.
  // -F also suppresses /etc/ssh/ssh_config, so that path resolves user-only.
  // existsSync is load-bearing: ssh exits 255 on a missing -F file. Without a HOME
  // config we fall back to passwd-home resolution, whose aliases the picker cannot
  // list — resolveUserSshConfigHost rejects those before trusting ssh -G.
  const homeConfigPath = join(homedir(), '.ssh', 'config')
  if (existsSync(homeConfigPath) && homeConfigPath !== passwdHomeSshConfigPath()) {
    return ['-F', homeConfigPath, '-G', '--', host]
  }
  return ['-G', '--', host]
}

/** OpenSSH's system-wide client config, which `-F` excludes along with the per-user one. */
const SITE_SSH_CONFIG_FILES =
  process.platform === 'win32'
    ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'ssh_config')]
    : ['/etc/ssh/ssh_config']

const STRICT_HOST_KEY_DIRECTIVE = /^\s*stricthostkeychecking\b/i
const INCLUDE_DIRECTIVE = /^\s*include\s+(.+?)\s*$/i
/** Glob syntax OpenSSH honours that expandSiteInclude does not expand; `*` is handled separately. */
const OTHER_GLOB_METACHARACTER = /[?[\]]/

/**
 * Whether the system-wide ssh_config could be setting StrictHostKeyChecking.
 *
 * Needed because `-F` excludes /etc/ssh/ssh_config as well as the per-user file, so on that path the
 * resolved config cannot represent a site policy — and there is no ssh-only way to read one while
 * suppressing the other. `-F /dev/null` does NOT invert the exclusion; it reports built-in defaults,
 * which would make this look permissive on every machine.
 *
 * So this reads the file instead, and deliberately answers a WEAKER question than "what is the
 * policy". Anything ambiguous — unreadable, an Include we cannot resolve, the directive present at
 * all — answers true and the caller stays fail-closed. Only a site config that demonstrably says
 * nothing about host keys clears it, which is the common case this exists to stop punishing.
 *
 * "Ambiguous" has to include every path we do not fully model, and the failures here were all the
 * same shape: a path we resolved WRONG still resolved to something, and a nonexistent Include reads
 * as "nothing there" — which is indistinguishable from "no policy". So an Include we would have to
 * expand tokens or unsupported globs in returns doubt rather than a literal path, and relative
 * Includes resolve the way OpenSSH resolves them rather than the way that merely looks right.
 */
export async function siteConfigMayRestrictHostKeys(
  files: readonly string[] = SITE_SSH_CONFIG_FILES
): Promise<boolean> {
  const seen = new Set<string>()
  const pending = [...files]
  // OpenSSH resolves a relative Include against a FIXED directory — SSHDIR for the system config —
  // not against the including file's own directory. Those agree at depth 1 and diverge below it, so
  // passing dirname(file) silently missed a directive one level down. Verified against 10.2p1.
  // One base for the whole walk, which holds only while SITE_SSH_CONFIG_FILES names a single
  // directory. A second entry elsewhere would need its own base tracked per queued file.
  const siteConfigDir = dirname(files[0] ?? SITE_SSH_CONFIG_FILES[0])
  // Bounded so an Include cycle cannot spin; OpenSSH allows nesting, we only need "any mention".
  for (let visited = 0; pending.length > 0 && visited < 32; visited += 1) {
    const file = pending.shift()
    if (!file || seen.has(file)) {
      continue
    }
    seen.add(file)
    let contents: string
    try {
      contents = await readFile(file, 'utf-8')
    } catch (error) {
      // Absent is a real answer: no file, no site policy. Anything else is doubt, so stay strict.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      return true
    }
    for (const line of contents.split(/\r?\n/)) {
      if (STRICT_HOST_KEY_DIRECTIVE.test(line)) {
        return true
      }
      const include = INCLUDE_DIRECTIVE.exec(line)
      if (include) {
        const expanded = await expandSiteInclude(include[1], siteConfigDir)
        if (expanded === null) {
          return true
        }
        pending.push(...expanded)
      }
    }
  }
  // Ran out of budget with files still queued: unresolved, so doubt wins.
  return pending.length > 0
}

/**
 * One Include's arguments, or null when the line cannot be read with confidence.
 *
 * Every spelling OpenSSH accepts for a path with a space has to hold together here, because the ones
 * that don't fail OPEN: splitting produces fragments that resolve to nothing, and "nothing there" is
 * indistinguishable from "no site policy". `"a b/x"`, `'a b/x'` and `a\ b/x` are all honoured, on
 * BOTH platforms — measured against 10.2p1 and against Windows OpenSSH, where a path with a space is
 * ordinary. An UNQUOTED space still splits, which also matches OpenSSH: it reads that as two paths.
 *
 * `backslashIsSeparator` exists because there is no single correct rule, and shipping either one
 * everywhere fails open on the other platform. Both halves are measured, not reasoned:
 * - POSIX (10.2p1): a backslash before an ordinary character ESCAPES it — `conf\.d` resolves as
 *   `conf.d`, and it takes four backslashes to survive as one, because argv_split and glob() each
 *   consume a level. Preserving it there means looking for a path with a literal backslash, missing,
 *   and reading "no policy". Rather than reimplement two rounds of glob escaping for a question this
 *   coarse, POSIX answers doubt — a backslash in a POSIX system config path is vanishingly rare, so
 *   fail-closed costs nothing here.
 * - Windows: a backslash is the SEPARATOR and is preserved. `Include C:\Users\...\x.conf` resolves,
 *   as does `C:\...\sp\ ace\x.conf` — so escaping-before-whitespace holds there too. Consuming
 *   backslashes generally would eat every separator beneath C:\ProgramData\ssh and reinstate the
 *   fail-open on the platform this matters most for; answering doubt for any backslash would
 *   reinstate the lockout, since every absolute Windows Include contains them.
 */
export function splitIncludeArguments(
  pattern: string,
  backslashIsSeparator: boolean = process.platform === 'win32'
): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\' && /\s/.test(pattern[index + 1] ?? '')) {
      // An escaped space, honoured on both platforms.
      current += pattern[index + 1]
      index += 1
      started = true
    } else if (char === '\\' && !backslashIsSeparator) {
      // POSIX: this escapes the next character and we do not emulate that. See the header.
      return null
    } else if (quote ? char === quote : char === '"' || char === "'") {
      quote = quote ? null : (char as '"' | "'")
      started = true
    } else if (!quote && /\s/.test(char)) {
      if (started) {
        tokens.push(current)
      }
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  // An unterminated quote means we cannot know where the path ended — OpenSSH rejects the whole
  // config for it — so there is no reading to trust and doubt wins.
  if (quote) {
    return null
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

/** Resolves one Include's globs, or null when it cannot be resolved and doubt must win. */
async function expandSiteInclude(pattern: string, baseDir: string): Promise<string[] | null> {
  const resolved: string[] = []
  const tokens = splitIncludeArguments(pattern)
  if (tokens === null) {
    return null
  }
  for (const token of tokens) {
    // `~` and OpenSSH's `%d`/`%u`-style tokens both expand before the path is used. Resolving them
    // is not worth it for a question this coarse, but treating them as ordinary characters is what
    // made this fail OPEN: the join produced a path that does not exist, and a nonexistent Include
    // reads as "nothing there" — indistinguishable from a site that says nothing about host keys.
    if (token.startsWith('~') || token.includes('%')) {
      return null
    }
    const absolute = isAbsolute(token) ? token : join(baseDir, token)
    // `?` and `[…]` are globs to OpenSSH too, and it does honour them (verified against 10.2p1).
    // Only `*` is expanded below, so any other metacharacter is doubt rather than a literal — taking
    // it literally is the same fail-open as `~`: the path does not exist, so it reads as "nothing".
    if (OTHER_GLOB_METACHARACTER.test(absolute)) {
      return null
    }
    const star = absolute.indexOf('*')
    if (star === -1) {
      resolved.push(absolute)
      continue
    }
    // Only the trailing `dir/*` form OpenSSH ships by default is expanded; anything fancier is doubt.
    const dir = dirname(absolute.slice(0, star + 1))
    if (absolute.slice(star + 1).includes('/')) {
      return null
    }
    try {
      const entries = await readdir(dir)
      resolved.push(...entries.map((entry) => join(dir, entry)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return null
      }
    }
  }
  return resolved
}

// Why: `ssh -G <host>` asks OpenSSH for the effective config, including
// Include/Match/wildcard inheritance, without reimplementing OpenSSH matching.
export async function resolveWithSshG(host: string): Promise<SshResolvedConfig | null> {
  // Why: '--' prevents host labels starting with '-' from becoming SSH flags.
  // ssh.exe is console-subsystem, so this probe used to flash a conhost that
  // took foreground mid-typing on every connect and reconnect (#10488);
  // runProcess hides it and owns the timeout.
  try {
    const result = await runProcess({
      program: 'ssh',
      args: sshGArgsForHost(host),
      timeoutMs: SSH_G_TIMEOUT_MS
    })
    if (result.code !== 0 || result.timedOut) {
      return null
    }
    return parseSshGOutput(result.stdout)
  } catch {
    return null
  }
}

export function parseSshGOutput(stdout: string): SshResolvedConfig {
  const map = new Map<string, string>()
  const identityFiles: string[] = []

  for (const line of stdout.split('\n')) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) {
      continue
    }
    const key = line.substring(0, spaceIdx).toLowerCase()
    const value = line.substring(spaceIdx + 1).trim()
    if (key === 'identityfile') {
      identityFiles.push(resolveSshConfigHomePath(value))
    } else {
      map.set(key, value)
    }
  }

  return buildSshResolvedConfig(map, identityFiles)
}

/**
 * `userknownhostsfile` / `globalknownhostsfile` arrive as one space-separated line; a path
 * containing spaces is double-quoted. Older OpenSSH leaves `~` unexpanded, newer expands it.
 */
function parseKnownHostsFileList(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  const paths: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes
      hasToken = true
      continue
    }
    if (!inQuotes && /\s/.test(char)) {
      if (hasToken) {
        paths.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (hasToken) {
    paths.push(current)
  }
  return paths.map(resolveSshConfigHomePath)
}

function buildSshResolvedConfig(
  map: Map<string, string>,
  identityFiles: string[]
): SshResolvedConfig {
  // Why: `ssh -G` outputs `proxycommand none` / `proxyjump none` when no
  // proxy is configured. Treating "none" as real would spawn bad commands.
  const rawProxy = map.get('proxycommand')
  const proxyCommand = rawProxy && rawProxy !== 'none' ? rawProxy : undefined
  const rawJump = map.get('proxyjump')
  const proxyJump = rawJump && rawJump !== 'none' ? rawJump : undefined
  const rawIdentityAgent = map.get('identityagent')
  const identityAgent = rawIdentityAgent ? resolveSshConfigHomePath(rawIdentityAgent) : undefined
  const rawControlPath = map.get('controlpath')
  const controlPath =
    rawControlPath && rawControlPath !== 'none'
      ? resolveSshConfigHomePath(rawControlPath)
      : undefined

  return {
    hostname: map.get('hostname') ?? '',
    user: map.get('user') || undefined,
    port: Number.parseInt(map.get('port') ?? '22', 10),
    identityFile: identityFiles,
    identityAgent,
    identitiesOnly: map.get('identitiesonly') === 'yes',
    forwardAgent: map.get('forwardagent') === 'yes',
    gssapiAuthentication: map.get('gssapiauthentication') === 'yes',
    proxyCommand,
    proxyUseFdpass: map.get('proxyusefdpass') === 'yes',
    proxyJump,
    controlMaster: map.get('controlmaster') ?? 'no',
    controlPath,
    controlPersist: map.get('controlpersist') ?? 'no',
    userKnownHostsFiles: parseKnownHostsFileList(map.get('userknownhostsfile')),
    globalKnownHostsFiles: parseKnownHostsFileList(map.get('globalknownhostsfile')),
    // OpenSSH's own default, so an unreadable line never resolves laxer than ssh would.
    strictHostKeyChecking: map.get('stricthostkeychecking') ?? 'ask',
    hostKeyAlias: map.get('hostkeyalias') || undefined,
    hashKnownHosts: map.get('hashknownhosts') === 'yes',
    updateHostKeys: map.get('updatehostkeys') ?? 'no'
  }
}
