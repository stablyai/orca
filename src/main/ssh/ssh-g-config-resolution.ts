import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

// Why: `ssh -G <host>` asks OpenSSH for the effective config, including
// Include/Match/wildcard inheritance, without reimplementing OpenSSH matching.
export function resolveWithSshG(host: string): Promise<SshResolvedConfig | null> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      resolve(null)
    }, SSH_G_TIMEOUT_MS)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    // Why: '--' prevents host labels starting with '-' from becoming SSH flags.
    // execFile's timeout only signals ssh; keep the null fallback for stuck callbacks.
    try {
      child = execFile(
        'ssh',
        sshGArgsForHost(host),
        { timeout: SSH_G_TIMEOUT_MS },
        (err, stdout) => {
          if (err) {
            settle(() => resolve(null))
            return
          }
          settle(() => resolve(parseSshGOutput(stdout)))
        }
      )
    } catch {
      settle(() => resolve(null))
    }
  })
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
    controlPersist: map.get('controlpersist') ?? 'no'
  }
}
