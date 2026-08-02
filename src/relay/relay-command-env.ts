import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { gitCredentialPromptGuardEnv } from '../shared/git-credential-prompt-env'
import { UNTRANSLATED_GIT_OUTPUT_ENV } from '../shared/git-output-locale'

const POSIX_RELAY_PATH_FALLBACKS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
const WINDOWS_RELAY_PATH_FALLBACKS = [
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Git\\bin',
  'C:\\Windows\\System32',
  'C:\\Windows'
]

// Why: the login-shell probe (`/bin/sh -lc`) sources ~/.profile but not the
// interactive ~/.bashrc, so per-user package-manager bins are invisible to
// detection even though the user can run those agents. Add them to PATH so the
// relay sees what interactive PTY sessions do; prefer each tool's documented
// relocation env var over the $HOME default so relocated installs stay covered.
function getPosixUserInstallBinFallbacks(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const home = baseEnv.HOME || homedir()
  const bins: string[] = []
  if (baseEnv.PNPM_HOME) {
    bins.push(baseEnv.PNPM_HOME)
  }
  if (home) {
    bins.push(posix.join(home, '.local', 'bin'), posix.join(home, '.npm-global', 'bin'))
    if (platform === 'darwin') {
      bins.push(posix.join(home, 'Library', 'pnpm'))
    }
  }
  const cargoBin = baseEnv.CARGO_HOME
    ? posix.join(baseEnv.CARGO_HOME, 'bin')
    : home
      ? posix.join(home, '.cargo', 'bin')
      : null
  if (cargoBin) {
    bins.push(cargoBin)
  }
  const bunBin = baseEnv.BUN_INSTALL
    ? posix.join(baseEnv.BUN_INSTALL, 'bin')
    : home
      ? posix.join(home, '.bun', 'bin')
      : null
  if (bunBin) {
    bins.push(bunBin)
  }
  const denoBin = baseEnv.DENO_INSTALL
    ? posix.join(baseEnv.DENO_INSTALL, 'bin')
    : home
      ? posix.join(home, '.deno', 'bin')
      : null
  if (denoBin) {
    bins.push(denoBin)
  }
  // GOBIN is the bin dir itself; otherwise go installs into $GOPATH/bin (default ~/go/bin).
  const goBin = baseEnv.GOBIN
    ? baseEnv.GOBIN
    : baseEnv.GOPATH
      ? posix.join(baseEnv.GOPATH, 'bin')
      : home
        ? posix.join(home, 'go', 'bin')
        : null
  if (goBin) {
    bins.push(goBin)
  }
  // pnpm/PNPM_HOME point at the global-bin dir directly; the default lives under
  // XDG_DATA_HOME (default ~/.local/share).
  const pnpmHome = baseEnv.PNPM_HOME
    ? null
    : baseEnv.XDG_DATA_HOME
      ? posix.join(baseEnv.XDG_DATA_HOME, 'pnpm')
      : home
        ? posix.join(home, '.local', 'share', 'pnpm')
        : null
  if (pnpmHome) {
    bins.push(pnpmHome)
  }
  const npmPrefix = baseEnv.npm_config_prefix
  if (npmPrefix) {
    bins.push(posix.join(npmPrefix, 'bin'))
  }
  return bins
}

function getWindowsUserInstallBinFallbacks(baseEnv: NodeJS.ProcessEnv): string[] {
  const bins = baseEnv.PNPM_HOME ? [baseEnv.PNPM_HOME] : []
  if (baseEnv.APPDATA) {
    bins.push(win32.join(baseEnv.APPDATA, 'npm'))
  }
  if (baseEnv.LOCALAPPDATA) {
    bins.push(win32.join(baseEnv.LOCALAPPDATA, 'pnpm'))
  }
  if (baseEnv.CARGO_HOME) {
    bins.push(win32.join(baseEnv.CARGO_HOME, 'bin'))
  }
  if (baseEnv.BUN_INSTALL) {
    bins.push(win32.join(baseEnv.BUN_INSTALL, 'bin'))
  }
  if (baseEnv.DENO_INSTALL) {
    bins.push(win32.join(baseEnv.DENO_INSTALL, 'bin'))
  }
  if (baseEnv.GOBIN) {
    bins.push(baseEnv.GOBIN)
  } else if (baseEnv.GOPATH) {
    bins.push(win32.join(baseEnv.GOPATH, 'bin'))
  }
  if (baseEnv.USERPROFILE) {
    if (!baseEnv.CARGO_HOME) {
      bins.push(win32.join(baseEnv.USERPROFILE, '.cargo', 'bin'))
    }
    if (!baseEnv.BUN_INSTALL) {
      bins.push(win32.join(baseEnv.USERPROFILE, '.bun', 'bin'))
    }
    if (!baseEnv.GOBIN && !baseEnv.GOPATH) {
      bins.push(win32.join(baseEnv.USERPROFILE, 'go', 'bin'))
    }
    if (!baseEnv.DENO_INSTALL) {
      bins.push(win32.join(baseEnv.USERPROFILE, '.deno', 'bin'))
    }
  }
  return bins
}

function getPathKey(env: NodeJS.ProcessEnv): 'PATH' | 'Path' {
  return env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH'
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function getFallbackSegments(platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [...WINDOWS_RELAY_PATH_FALLBACKS, ...getWindowsUserInstallBinFallbacks(baseEnv)]
  }
  return [...POSIX_RELAY_PATH_FALLBACKS, ...getPosixUserInstallBinFallbacks(baseEnv, platform)]
}

export function buildRelayCommandEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const key = getPathKey(baseEnv)
  const delimiter = getPathDelimiter(platform)
  const segments = new Set((baseEnv[key] ?? '').split(delimiter).filter(Boolean))

  for (const segment of getFallbackSegments(platform, baseEnv)) {
    segments.add(segment)
  }

  return {
    ...baseEnv,
    [key]: [...segments].join(delimiter)
  }
}

/**
 * Env for relay-spawned git specifically: the PATH fallbacks above plus a
 * pinned English UTF-8 locale, because relay git output is machine-parsed
 * (stderr phrase matching, progress regexes) and a gettext-enabled git under
 * a non-English host locale translates it (issue #7808).
 */
export function buildRelayGitEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  return { ...buildRelayCommandEnv(baseEnv, platform), ...UNTRANSLATED_GIT_OUTPUT_ENV }
}

/** Env for unattended Git RPCs, which have no terminal that can answer auth UI. */
export function buildRelayUnattendedGitEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  // Why: SSH-host GCM can open its own OAuth window even though the clone's
  // stdin is ignored, leaving the relay request hung with no way to answer it.
  const env = gitCredentialPromptGuardEnv(buildRelayGitEnv(baseEnv, platform), platform)
  env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes'
  return env
}
