import { toWindowsWslPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'

// Re-exported: the pure env/path resolution moved to `shared` so the `orca` CLI can reach
// the same verdict about which roots `npx skills update` writes into. Only the WSL probes
// below need a distro, which is why they stayed.
export {
  resolveDefaultHermesSkillsRoot,
  resolveEnvironmentHermesSkillsRoot,
  resolveEnvironmentSkillProviderRoots,
  withClaudeSkillProviderRoot
} from '../../shared/agent-skill-provider-root-overrides'

const WSL_ENV_PROBE_TIMEOUT_MS = 8_000
const WSL_ENV_PROBE_MAX_BYTES = 4_097
const WSL_GROK_HOME_SCRIPT = [
  'entry=$(getent passwd "$(id -u)" 2>/dev/null || true)',
  'login_shell=${entry##*:}',
  'case "$login_shell" in /*) ;; *) login_shell=/bin/sh ;; esac',
  `exec "$login_shell" -lc 'printf %s "\${GROK_HOME:-}" | head -c ${WSL_ENV_PROBE_MAX_BYTES}'`
].join('\n')

type WslEnvironmentProbe = (distro: string) => Promise<string>

async function probeWslGrokHome(distro: string): Promise<string> {
  const result = await runWslProcess({
    distro,
    // 'none': the script runs its own `"$login_shell" -lc`, so asking the
    // runner to probe first buys a second login shell and spends up to half
    // the 8s budget before the -lc that actually reads GROK_HOME starts.
    loginPath: 'none',
    script: WSL_GROK_HOME_SCRIPT,
    // POSIX (`case`, `exec`); declared because the payload is opaque here.
    shell: 'sh',
    timeoutMs: WSL_ENV_PROBE_TIMEOUT_MS,
    maxOutputBytes: WSL_ENV_PROBE_MAX_BYTES
  })
  // A timeout mid-write can leave a truncated but shape-valid absolute path.
  if (result.code !== 0 || result.timedOut) {
    return ''
  }
  return result.stdout
}

export async function resolveWslGrokSkillProviderRoot(
  distro: string,
  probe: WslEnvironmentProbe = probeWslGrokHome
): Promise<string | null> {
  try {
    const value = await probe(distro)
    const candidate = value.trim()
    if (
      !candidate ||
      candidate.length >= WSL_ENV_PROBE_MAX_BYTES ||
      !candidate.startsWith('/') ||
      candidate.includes('\\') ||
      Array.from(candidate).some((character) => {
        const code = character.charCodeAt(0)
        return code <= 0x1f || code === 0x7f
      })
    ) {
      return null
    }
    const grokHome = candidate.replace(/\/+$/u, '') || '/'
    return toWindowsWslPath(`${grokHome === '/' ? '' : grokHome}/skills`, distro)
  } catch {
    return null
  }
}
