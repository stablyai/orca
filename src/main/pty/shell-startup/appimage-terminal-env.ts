import { delimiter } from 'node:path'

const APPIMAGE_RUNTIME_ENV_KEYS = [
  'APPIMAGE',
  'APPDIR',
  'ARGV0',
  'OWD',
  'APPIMAGE_LIBRARY_PATH'
] as const

function normalizeAppDir(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '') ?? ''
  return trimmed.startsWith('/') ? trimmed : null
}

function isInsideAppDir(entry: string, appDir: string): boolean {
  const normalized = entry.replace(/\/+$/, '')
  return normalized === appDir || normalized.startsWith(`${appDir}/`)
}

function removeAppDirPathEntries(value: string | undefined, appDir: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const cleaned = value
    .split(delimiter)
    .filter((entry) => !isInsideAppDir(entry, appDir))
    .join(delimiter)
  return cleaned.length > 0 ? cleaned : undefined
}

export function envWithoutAppImageRuntime(env: NodeJS.ProcessEnv): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      copy[key] = value
    }
  }
  removeAppImageRuntimeEnv(copy)
  return copy
}

export function removeAppImageRuntimeEnv(env: Record<string, string>): void {
  if (process.platform !== 'linux' || (!env.APPIMAGE && !env.APPDIR && !env.ARGV0)) {
    return
  }

  // Exported ARGV0 makes zsh invoke host commands under the AppImage name.
  const appDir = normalizeAppDir(env.APPDIR)
  if (appDir) {
    // AppImage loader paths must not replace host commands or libraries in user shells.
    for (const key of ['PATH', 'LD_LIBRARY_PATH'] as const) {
      const cleaned = removeAppDirPathEntries(env[key], appDir)
      if (cleaned === undefined) {
        delete env[key]
      } else {
        env[key] = cleaned
      }
    }
  }

  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete env[key]
  }
}
