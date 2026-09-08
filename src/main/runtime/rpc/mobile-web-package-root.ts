import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'

type MobileWebPackageRootOptions = {
  cwd?: string
  isPackaged?: boolean
  overrideRoot?: string
  resourcesPath?: string
}

export function resolveMobileWebPackageRoot(options: MobileWebPackageRootOptions = {}): string {
  const isPackaged = options.isPackaged ?? (hasAppEnvironment() && getAppEnvironment().isPackaged())
  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (isPackaged) {
    return requirePackageRoot(resourcesPath ? join(resourcesPath, 'mobile-web') : null)
  }

  const overrideRoot = options.overrideRoot ?? process.env.ORCA_MOBILE_WEB_PACKAGE_ROOT
  const candidates = [
    overrideRoot ? resolve(overrideRoot) : null,
    resolveDevelopmentRoot(options)
  ].filter((candidate): candidate is string => candidate !== null)

  const root = candidates.find((candidate) => existsSync(join(candidate, 'manifest.json')))
  return requirePackageRoot(root ?? null)
}

function resolveDevelopmentRoot(options: MobileWebPackageRootOptions): string {
  return resolve(options.cwd ?? process.cwd(), 'out', 'mobile-web-rnw')
}

function requirePackageRoot(root: string | null): string {
  if (!root || !existsSync(join(root, 'manifest.json'))) {
    throw new Error('mobile_web_package_unavailable')
  }
  return root
}
