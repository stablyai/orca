import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { DEFAULT_MAC_COMMAND_PATH, DEV_COMMAND_NAME } from './cli-install-constants'
import { ensureDevLauncher } from './cli-dev-launcher'
import type { CliInstallerOptions, InstallSpec } from './cli-installer-contracts'
import {
  isExecutableFile,
  samePathEntry,
  splitPathEntries,
  uniquePathEntries
} from './cli-install-path-format'
import { runMacPrivilegedCommand, writeWindowsUserPath } from './cli-privileged-processes'
import { getBundledLauncherPath, LINUX_CLI_COMMAND_NAME } from './bundled-cli-launcher-path'
import {
  invalidateWindowsUserPathRegistryCache,
  readFreshWindowsUserPathRegistry,
  readWindowsUserPathRegistry,
  type WindowsUserPathReadResult
} from './windows-user-path-registry'

export abstract class CliInstallLocation {
  protected abstract inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus>
  protected abstract isLinuxAppImage(): boolean

  protected readonly platform: NodeJS.Platform
  protected readonly isPackaged: boolean
  protected readonly userDataPath: string
  protected readonly resourcesPath: string
  protected readonly execPathValue: string
  protected readonly appPathValue: string
  protected readonly homePath: string
  protected readonly localAppDataPath: string
  protected readonly processPathEnv: string | null
  protected readonly commandPathOverride: string | null
  protected readonly macCommandPath: string
  protected readonly privilegedRunner: (command: string) => Promise<void>
  protected readonly userPathReader: () => Promise<WindowsUserPathReadResult>
  protected readonly userPathMutationReader: () => Promise<WindowsUserPathReadResult>
  protected readonly userPathWriter: (value: string) => Promise<void>
  protected readonly userPathCacheInvalidator: () => void
  protected readonly windowsEnvironment: NodeJS.ProcessEnv
  protected readonly appImagePath: string | null

  protected get commandName(): string {
    if (!this.isPackaged && !this.commandPathOverride) {
      // Why: development builds must not claim the production shell command.
      return DEV_COMMAND_NAME
    }
    // Why: packaged Linux uses `orca-ide` to avoid shadowing GNOME Orca's /usr/bin/orca.
    return this.platform === 'linux' ? LINUX_CLI_COMMAND_NAME : 'orca'
  }

  constructor(options: CliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.isPackaged = options.isPackaged ?? getAppEnvironment().isPackaged()
    this.userDataPath = options.userDataPath ?? getAppEnvironment().getPath('userData')
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath
    this.execPathValue = options.execPath ?? process.execPath
    this.appPathValue = options.appPath ?? getAppEnvironment().getAppPath()
    this.homePath = options.homePath ?? homedir()
    this.localAppDataPath =
      options.localAppDataPath ??
      process.env.LOCALAPPDATA ??
      join(this.homePath, 'AppData', 'Local')
    this.processPathEnv = options.processPathEnv ?? process.env.PATH ?? process.env.Path ?? null
    this.commandPathOverride =
      options.commandPathOverride ?? process.env.ORCA_CLI_INSTALL_PATH ?? null
    // Why: resolved once here (getStatus is hot); /usr/local/bin is absent on Apple Silicon, so fall back to user-writable ~/.local/bin.
    const candidateMacPath = options.defaultMacCommandPath ?? DEFAULT_MAC_COMMAND_PATH
    this.macCommandPath = existsSync(dirname(candidateMacPath))
      ? candidateMacPath
      : join(this.homePath, '.local', 'bin', 'orca')
    this.privilegedRunner = options.privilegedRunner ?? runMacPrivilegedCommand
    this.userPathReader = options.userPathReader ?? readWindowsUserPathRegistry
    this.userPathMutationReader =
      options.userPathMutationReader ?? options.userPathReader ?? readFreshWindowsUserPathRegistry
    this.userPathWriter = options.userPathWriter ?? ((value) => writeWindowsUserPath(value))
    this.userPathCacheInvalidator =
      options.userPathCacheInvalidator ?? invalidateWindowsUserPathRegistryCache
    this.windowsEnvironment = options.windowsEnvironment ?? process.env
    this.appImagePath =
      this.platform === 'linux' && this.isPackaged
        ? (options.appImagePath ?? process.env.APPIMAGE ?? null)
        : null
  }

  protected resolveInstallSpec(): InstallSpec | null {
    const commandPath = this.resolveCommandPath()
    if (!commandPath) {
      return null
    }

    if (this.platform === 'darwin' || this.platform === 'linux') {
      return {
        commandPath,
        installMethod: this.isLinuxAppImage() ? 'wrapper' : 'symlink'
      }
    }

    if (this.platform === 'win32') {
      return {
        commandPath,
        installMethod: 'wrapper'
      }
    }

    return null
  }

  protected async resolveActiveInstallSpec(
    defaultSpec: InstallSpec,
    launcherPath: string
  ): Promise<InstallSpec> {
    if (
      this.commandPathOverride ||
      this.platform !== 'darwin' ||
      defaultSpec.installMethod !== 'symlink'
    ) {
      return defaultSpec
    }

    const activeCommandPath = await this.findActivePathCommand(
      launcherPath,
      defaultSpec.commandPath
    )
    return activeCommandPath
      ? {
          commandPath: activeCommandPath,
          installMethod: defaultSpec.installMethod
        }
      : defaultSpec
  }

  protected async findActivePathCommand(
    launcherPath: string,
    defaultCommandPath: string
  ): Promise<string | null> {
    let reachedDefaultCommandPath = false
    for (const commandPath of this.getPathCommandCandidates(defaultCommandPath)) {
      const isDefaultCommandPath = samePathEntry(this.platform, commandPath, defaultCommandPath)
      reachedDefaultCommandPath ||= isDefaultCommandPath

      if (!(await isExecutableFile(commandPath))) {
        continue
      }

      const status = await this.inspectSymlink(commandPath, launcherPath)
      if (status.state !== 'not_installed') {
        if (reachedDefaultCommandPath && !isDefaultCommandPath && status.state === 'conflict') {
          // Why: a non-Orca command after an empty default slot can be shadowed by installing there; no user file replaced.
          continue
        }
        // Why: PATH lookup is first-match-wins; return the command the shell will actually run, preserving shadowing conflicts.
        return commandPath
      }
    }
    return null
  }

  protected getPathCommandCandidates(defaultCommandPath: string): string[] {
    const commandName = basename(defaultCommandPath)
    const pathCandidates = splitPathEntries(this.platform, this.processPathEnv ?? '').map((entry) =>
      join(entry, commandName)
    )
    return uniquePathEntries(this.platform, pathCandidates)
  }

  protected resolveCommandPath(): string | null {
    if (this.commandPathOverride) {
      return this.commandPathOverride
    }

    if (!this.isPackaged) {
      // Why: dev uses a separate command; tests/diagnostics still reach production paths via commandPathOverride.
      if (this.platform === 'darwin') {
        return `/usr/local/bin/${DEV_COMMAND_NAME}`
      }
      if (this.platform === 'linux') {
        return join(this.homePath, '.local', 'bin', DEV_COMMAND_NAME)
      }
      if (this.platform === 'win32') {
        return join(this.localAppDataPath, 'Programs', 'Orca Dev', 'bin', `${DEV_COMMAND_NAME}.cmd`)
      }
    }

    if (this.platform === 'darwin') {
      return this.macCommandPath
    }

    if (this.platform === 'linux') {
      // Why: Linux lacks a privileged global command flow; ~/.local/bin is the least-surprising user-scoped dir.
      // Why `orca-ide`: GNOME Orca ships /usr/bin/orca, so avoid shadowing that screen reader.
      return join(this.homePath, '.local', 'bin', LINUX_CLI_COMMAND_NAME)
    }

    if (this.platform === 'win32') {
      // Why: NSIS /D installs can live outside LOCALAPPDATA, so use the packaged resources dir as authoritative.
      return getBundledLauncherPath(this.platform, this.resourcesPath)
    }

    return null
  }

  protected async resolveLauncherPath(): Promise<string | null> {
    if (!['darwin', 'linux', 'win32'].includes(this.platform)) {
      return null
    }

    if (this.isLinuxAppImage()) {
      return this.appImagePath && existsSync(this.appImagePath) ? this.appImagePath : null
    }

    if (this.isPackaged) {
      const bundledPath = getBundledLauncherPath(this.platform, this.resourcesPath)
      return bundledPath && existsSync(bundledPath) ? bundledPath : null
    }

    return ensureDevLauncher({
      platform: this.platform,
      userDataPath: this.userDataPath,
      execPath: this.execPathValue,
      cliEntryPath: join(this.appPathValue, 'out', 'cli', 'index.js'),
      commandName: this.commandName
    })
  }
}
