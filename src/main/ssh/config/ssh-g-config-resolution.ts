import { runProcess } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import { expandIdentityFileTokens } from './ssh-identity-file-tokens'

export type SshResolvedConfig = {
  hostname: string
  user?: string
  port: number
  identityFile: string[]
  identityAgent?: string
  identitiesOnly: boolean
  forwardAgent: boolean
  /** Includes system GSSAPI defaults except HOME-divergent -F resolution, which skips site config. */
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
  // OpenSSH uses passwd home, Node uses HOME. Pin an existing divergent picker config with -F; matching homes retain system config. Missing files cannot use -F (exit255).
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

/** -F hides site config, so inspect it separately. Only demonstrable absence of host-key policy permits relaxation; unreadable files, unsupported Includes or any directive remain uncertain. */
export async function siteConfigMayRestrictHostKeys(
  files: readonly string[] = SITE_SSH_CONFIG_FILES
): Promise<boolean> {
  const seen = new Set<string>()
  const pending = [...files]
  // Use one fixed SSHDIR base for all Includes, matching OpenSSH10.2p1. Multiple root directories would need per-root bases.
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

/** Preserve quoted/escaped spaces as measured on POSIX and Windows OpenSSH. Windows backslashes separate paths; unsupported POSIX escape/glob layers return uncertainty rather than a false absent path. */
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
  // Unterminated quotes invalidate OpenSSH config; no trusted path can be inferred.
  if (quote) {
    return null
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

async function expandSiteInclude(pattern: string, baseDir: string): Promise<string[] | null> {
  const resolved: string[] = []
  const tokens = splitIncludeArguments(pattern)
  if (tokens === null) {
    return null
  }
  for (const token of tokens) {
    // Unsupported ~/% expansion must remain uncertain; literal paths would falsely imply absent policy.
    if (token.startsWith('~') || token.includes('%')) {
      return null
    }
    const absolute = isAbsolute(token) ? token : join(baseDir, token)
    // Unexpanded ?/[] globs must remain uncertain, not literal missing paths.
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

// Delegate Include/Match/wildcard resolution to OpenSSH rather than duplicate its rules.
export async function resolveWithSshG(host: string): Promise<SshResolvedConfig | null> {
  // -- prevents option injection; process-host hides console windows and bounds this probe (#10488).
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
  const rawIdentityFiles: string[] = []

  for (const line of stdout.split('\n')) {
    const spaceIdx = line.indexOf(' ')
    if (spaceIdx === -1) {
      continue
    }
    const key = line.substring(0, spaceIdx).toLowerCase()
    const value = line.substring(spaceIdx + 1).trim()
    if (key === 'identityfile') {
      // `IdentityFile none` loads no key; it is not a path.
      if (value.toLowerCase() !== 'none') {
        rawIdentityFiles.push(value)
      }
    } else {
      map.set(key, value)
    }
  }

  // Tokens need hostname/user/port, which ssh -G may print after identityfile lines.
  const identityFiles = rawIdentityFiles.map((value) =>
    resolveSshConfigHomePath(expandIdentityFileTokens(value, map))
  )
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
  // OpenSSH prints none for absent proxies; never spawn it as a command.
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
