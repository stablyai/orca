import type { CliInstallMethod } from '../../shared/cli-install-types'
import type { WindowsUserPathReadResult } from './windows-user-path-registry'

export type CliInstallerOptions = {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  userDataPath?: string
  resourcesPath?: string
  execPath?: string
  appPath?: string
  homePath?: string
  localAppDataPath?: string
  processPathEnv?: string | null
  commandPathOverride?: string | null
  /** Feeds into the /usr/local/bin existence check at construction time; used in tests to simulate absent /usr/local/bin on arm64 without relying on real filesystem state. */
  defaultMacCommandPath?: string
  privilegedRunner?: (command: string) => Promise<void>
  userPathReader?: () => Promise<WindowsUserPathReadResult>
  userPathMutationReader?: () => Promise<WindowsUserPathReadResult>
  userPathWriter?: (value: string) => Promise<void>
  userPathCacheInvalidator?: () => void
  windowsEnvironment?: NodeJS.ProcessEnv
  /** Trusted caller override; production discovers AppImage only from a complete runtime identity. */
  appImagePath?: string | null
  appImageCacheRootPath?: string
  appImageExtractRunner?: (appImagePath: string, cwd: string) => Promise<void>
}

export type InstallSpec = {
  commandPath: string
  installMethod: CliInstallMethod
}
