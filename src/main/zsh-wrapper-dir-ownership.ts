/** Accept real startup-file directories; reject Orca wrappers by their marker or legacy path shape. */
import { existsSync } from 'node:fs'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'

type EnvLike = Record<string, string | undefined>

const ZSH_STARTUP_FILES = ['.zshenv', '.zshrc', '.zprofile', '.zlogin'] as const

export function isOrcaOwnedZshWrapperDir(dir: string): boolean {
  const normalized = dir.replace(/\/+$/, '')
  if (!normalized) {
    return false
  }
  return (
    existsSync(`${normalized}/${ZSH_WRAPPER_DIR_MARKER_FILE}`) ||
    normalized.endsWith('/shell-ready/zsh')
  )
}

function usableInheritedZdotdir(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const normalized = value.replace(/\/+$/, '')
  if (!normalized || isOrcaOwnedZshWrapperDir(normalized)) {
    return null
  }
  if (!ZSH_STARTUP_FILES.some((file) => existsSync(`${normalized}/${file}`))) {
    return null
  }
  return value
}

/** Keep absent ZDOTDIR absent: assigning HOME would change the environment inherited by child processes. */
export function resolveInheritedZdotdir(env: EnvLike): string | null {
  return (
    usableInheritedZdotdir(env.ZDOTDIR) ?? usableInheritedZdotdir(env.ORCA_ORIG_ZDOTDIR) ?? null
  )
}

export function inheritedZdotdirEnv(inherited: string | null): Record<string, string> {
  return inherited ? { ORCA_ORIG_ZDOTDIR: inherited } : {}
}
