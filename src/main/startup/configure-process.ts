import { app } from 'electron'
import { join } from 'path'

export function installUncaughtPipeErrorGuard(): void {
  process.on('uncaughtException', (error) => {
    if (
      error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EIO' ||
        (error as NodeJS.ErrnoException).code === 'EPIPE')
    ) {
      return
    }

    throw error
  })
}

export function patchPackagedProcessPath(): void {
  if (!app.isPackaged || process.platform === 'win32') {
    return
  }

  const home = process.env.HOME ?? ''
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/snap/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/nix/var/nix/profiles/default/bin'
  ]

  if (home) {
    extraPaths.push(join(home, '.local/bin'), join(home, '.nix-profile/bin'))
  }

  const currentPath = process.env.PATH ?? ''
  const existing = new Set(currentPath.split(':'))
  const missing = extraPaths.filter((path) => !existing.has(path))

  if (missing.length > 0) {
    process.env.PATH = [...missing, ...currentPath.split(':').filter(Boolean)].join(':')
  }
}

export function configureDevUserDataPath(isDev: boolean): void {
  if (!isDev) {
    return
  }
  // Why: development runs share the same machine as packaged Orca, and both
  // publish runtime bootstrap files under userData. Without a dev-only path,
  // `pnpm dev` can overwrite the packaged app's runtime pointer and make the
  // public `orca` CLI look broken even though the packaged app is still open.
  app.setPath('userData', join(app.getPath('appData'), 'orca-dev'))
}

export function enableMainProcessGpuFeatures(): void {
  app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaGraphite')
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}
