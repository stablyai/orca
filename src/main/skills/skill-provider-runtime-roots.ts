import { homedir } from 'node:os'
import path, { isAbsolute, join, posix, resolve } from 'node:path'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import { buildWslCapturedLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import {
  type DefaultHermesHomeInput,
  resolveDefaultHermesHome
} from '../hermes/hermes-default-home'
import { runWslProcess } from '../wsl/wsl-runner'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'

const PROVIDER_ROOT_MAX_LENGTH = 32_768
const WSL_ENV_PROBE_TIMEOUT_MS = 8_000
const WSL_ENV_PROBE_VALUE_MAX_LENGTH = 4_096
// Room for rc output ahead of the fence; a clipped fence reads as a failed probe.
const WSL_ENV_PROBE_MAX_BYTES = 65_536
const PROVIDER_HOME_ENVS = SKILL_INSTALL_PROVIDERS.flatMap((provider) =>
  provider.homeEnv ? [{ id: provider.id, name: provider.homeEnv }] : []
)
// Why $HOME first: unusable homes are judged against the guest's own home.
const WSL_PROVIDER_HOMES_PROBE = buildWslCapturedLoginShellCommand(
  `printf '%s\\0' "$HOME" ${PROVIDER_HOME_ENVS.map(({ name }) => `"\${${name}:-}"`).join(' ')}`
)

type HomePathApi = Pick<typeof posix, 'dirname' | 'isAbsolute' | 'relative' | 'sep'>

/** Apply Kiro's root/home/ancestor rejection to every provider override so unrelated top-level folders cannot become skill roots. */
function isUsableProviderHome(candidate: string, userHome: string, pathApi: HomePathApi): boolean {
  if (pathApi.dirname(candidate) === candidate) {
    return false
  }
  const toUserHome = pathApi.relative(candidate, userHome)
  return (
    toUserHome === '..' ||
    toUserHome.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(toUserHome)
  )
}

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
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): SkillProviderRootOverrides {
  const roots: SkillProviderRootOverrides = {}
  for (const provider of SKILL_INSTALL_PROVIDERS) {
    const home = provider.homeEnv ? normalizedRoot(env[provider.homeEnv]) : null
    if (home && isUsableProviderHome(home, resolve(userHome), path)) {
      roots[provider.id] = join(home, 'skills')
    }
  }
  return roots
}

// HERMES_HOME relocates profile trees; honor it without adding Hermes to install-provider overrides.
export function resolveEnvironmentHermesSkillsRoot(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const hermesHome = normalizedRoot(env.HERMES_HOME)
  return hermesHome ? join(hermesHome, 'skills') : null
}

export function resolveDefaultHermesSkillsRoot(input: DefaultHermesHomeInput): string {
  return join(resolveDefaultHermesHome(input), 'skills')
}

export function withClaudeSkillProviderRoot(
  roots: SkillProviderRootOverrides,
  claudeConfigDirectory: string | null | undefined
): SkillProviderRootOverrides {
  const configDirectory = normalizedRoot(claudeConfigDirectory ?? undefined)
  return configDirectory ? { ...roots, claude: join(configDirectory, 'skills') } : roots
}

type WslEnvironmentProbe = (distro: string) => Promise<string | null>

async function probeWslProviderHomes(distro: string): Promise<string | null> {
  const result = await runWslProcess({
    distro,
    // The fenced command starts its own login shell; avoid a second probe within the 8s budget.
    loginPath: 'none',
    script: WSL_PROVIDER_HOMES_PROBE.command,
    shell: 'sh',
    timeoutMs: WSL_ENV_PROBE_TIMEOUT_MS,
    maxOutputBytes: WSL_ENV_PROBE_MAX_BYTES
  })
  if (result.code !== 0 || result.timedOut) {
    return null
  }
  return WSL_PROVIDER_HOMES_PROBE.readStdout(result.stdout)
}

function cleanWslPath(value: string): string | null {
  const candidate = value.trim()
  if (
    !candidate ||
    candidate.length > WSL_ENV_PROBE_VALUE_MAX_LENGTH ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    Array.from(candidate).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    return null
  }
  return posix.resolve(candidate)
}

/** Read every table homeEnv in one guest login-shell probe. */
export async function resolveWslSkillProviderRoots(
  distro: string,
  probe: WslEnvironmentProbe = probeWslProviderHomes
): Promise<SkillProviderRootOverrides> {
  try {
    // `$HOME` then each value, all NUL-terminated; any other shape is a broken probe.
    const fields = (await probe(distro))?.split('\0') ?? []
    if (fields.length !== PROVIDER_HOME_ENVS.length + 2) {
      return {}
    }
    const [rawUserHome, ...values] = fields
    // Without the guest home the root/home/ancestor guard cannot run.
    const userHome = cleanWslPath(rawUserHome)
    if (!userHome) {
      return {}
    }
    const roots: SkillProviderRootOverrides = {}
    PROVIDER_HOME_ENVS.forEach(({ id }, index) => {
      const home = cleanWslPath(values[index])
      if (home && isUsableProviderHome(home, userHome, posix)) {
        roots[id] = toWindowsWslPath(`${home}/skills`, distro)
      }
    })
    return roots
  } catch {
    return {}
  }
}
