import { isAbsolute, join, resolve } from 'node:path'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/wsl-runner'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'

const PROVIDER_ROOT_MAX_LENGTH = 32_768
const WSL_ENV_PROBE_TIMEOUT_MS = 8_000
const WSL_ENV_PROBE_MAX_BYTES = 4_097
const WSL_GROK_HOME_SCRIPT = [
  'entry=$(getent passwd "$(id -u)" 2>/dev/null || true)',
  'login_shell=${entry##*:}',
  'case "$login_shell" in /*) ;; *) login_shell=/bin/sh ;; esac',
  `exec "$login_shell" -lc 'printf %s "\${GROK_HOME:-}" | head -c ${WSL_ENV_PROBE_MAX_BYTES}'`
].join('\n')

function normalizedRoot(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (
    !candidate ||
    candidate.length > PROVIDER_ROOT_MAX_LENGTH ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    return null
  }
  return resolve(candidate)
}

export function resolveEnvironmentSkillProviderRoots(
  env: NodeJS.ProcessEnv = process.env
): SkillProviderRootOverrides {
  const claudeConfig = normalizedRoot(env.CLAUDE_CONFIG_DIR)
  const grokHome = normalizedRoot(env.GROK_HOME)
  return {
    ...(claudeConfig ? { claude: join(claudeConfig, 'skills') } : {}),
    ...(grokHome ? { grok: join(grokHome, 'skills') } : {})
  }
}

export function withClaudeSkillProviderRoot(
  roots: SkillProviderRootOverrides,
  claudeConfigDirectory: string | null | undefined
): SkillProviderRootOverrides {
  const configDirectory = normalizedRoot(claudeConfigDirectory ?? undefined)
  return configDirectory ? { ...roots, claude: join(configDirectory, 'skills') } : roots
}

type WslEnvironmentProbe = (distro: string) => Promise<string>

async function probeWslGrokHome(distro: string): Promise<string> {
  const result = await runWslProcess({
    distro,
    lane: 'probe',
    // Degrade rather than refuse: reads $HOME, which wsl.exe supplies without a login shell.
    allowDegradedEnvironment: true,
    script: WSL_GROK_HOME_SCRIPT,
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
