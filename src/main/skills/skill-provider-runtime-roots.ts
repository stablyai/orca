import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import { toWindowsWslPath } from '../../shared/wsl-paths'
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

function probeWslGrokHome(distro: string): Promise<string> {
  return new Promise((resolveProbe, reject) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--exec', 'sh', '-c', WSL_GROK_HOME_SCRIPT],
      {
        encoding: 'utf8',
        timeout: WSL_ENV_PROBE_TIMEOUT_MS,
        maxBuffer: WSL_ENV_PROBE_MAX_BYTES,
        windowsHide: true
      },
      (error, stdout) => (error ? reject(error) : resolveProbe(stdout))
    )
  })
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
