import { existsSync } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { CliInstallMethod, CliInstallStatus } from '../../shared/cli-install-types'
import { isAppImageExtractedLauncherPath } from './appimage-extracted-root'
import { DEV_COMMAND_NAME, DEV_LAUNCHER_DIR } from './cli-install-constants'
import { buildWindowsForwarder, extractManagedUnixLauncherTarget } from './cli-dev-launcher'
import { isMissingError } from './cli-install-errors'
import { CliInstallLocation } from './cli-install-location'
import { isPathInsideOrEqual, samePathEntry } from './cli-install-path-format'
import { extractLegacyAppImageCliWrapperTarget } from './legacy-appimage-cli-wrapper'

// Why: electron-builder's /opt directory name varies with productName sanitization, which is why
// resources/linux/packaging/after-install.sh enumerates all three of these. A symlink into one is a
// previous packaged Orca and is ours to reclaim; anything else stays a conflict.
const PACKAGED_LINUX_LAUNCHER_DIRECTORIES = ['/opt/Orca', '/opt/orca-ide', '/opt/orca']

export class CliCommandInspection extends CliInstallLocation {
  protected async inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isSymbolicLink()) {
        if (stats.isFile()) {
          const currentContent = await readFile(commandPath, 'utf8')
          const managedTarget =
            extractManagedUnixLauncherTarget(currentContent) ??
            extractLegacyAppImageCliWrapperTarget(currentContent)
          if (managedTarget) {
            return this.buildStatus({
              commandPath,
              launcherPath,
              installMethod: 'symlink',
              supported: true,
              state: 'stale',
              currentTarget: managedTarget,
              detail: `${commandPath} contains an older Orca launcher.`
            })
          }
        }

        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca symlink.`
        })
      }

      const currentTarget = await readlink(commandPath)
      const resolvedCurrentTarget = resolve(dirname(commandPath), currentTarget)
      const resolvedLauncher = resolve(launcherPath)
      const isInstalled = resolvedCurrentTarget === resolvedLauncher && existsSync(resolvedLauncher)
      const isManagedStaleTarget =
        !isInstalled &&
        (resolvedCurrentTarget === resolvedLauncher ||
          this.isManagedSymlinkTarget(resolvedCurrentTarget, launcherPath))
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'symlink',
        supported: true,
        state: isInstalled ? 'installed' : isManagedStaleTarget ? 'stale' : 'conflict',
        currentTarget: resolvedCurrentTarget,
        detail: isInstalled
          ? `Registered at ${commandPath}.`
          : isManagedStaleTarget
            ? `${commandPath} points to an older Orca launcher.`
            : `${commandPath} points to a non-Orca launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from the terminal.`
        })
      }
      throw error
    }
  }

  protected isManagedSymlinkTarget(resolvedTarget: string, launcherPath: string): boolean {
    const expectedName = basename(launcherPath)
    if (this.isPackaged && this.isSiblingDevLauncherTarget(resolvedTarget, expectedName)) {
      return true
    }

    if (basename(resolvedTarget) !== expectedName) {
      return false
    }

    const devLauncherDir = resolve(this.userDataPath, ...DEV_LAUNCHER_DIR)
    if (isPathInsideOrEqual(devLauncherDir, resolvedTarget)) {
      return true
    }

    if (this.platform === 'darwin') {
      // Why: reclaim symlinks to an older Orca.app launcher, but never replace arbitrary user-owned symlinks.
      return /(?:^|[/\\])[^/\\]+\.app[/\\]Contents[/\\]Resources[/\\]bin[/\\][^/\\]+$/.test(
        resolvedTarget
      )
    }

    if (this.platform === 'linux') {
      if (this.isPackagedLinuxLauncherTarget(resolvedTarget, expectedName)) {
        return true
      }
      const extractionOptions = this.appImageExtractionOptions()
      return extractionOptions
        ? isAppImageExtractedLauncherPath(extractionOptions, resolvedTarget)
        : false
    }

    return false
  }

  /** A launcher inside a packaged Linux install tree, left behind by a deb/rpm Orca. */
  protected isPackagedLinuxLauncherTarget(resolvedTarget: string, expectedName: string): boolean {
    return PACKAGED_LINUX_LAUNCHER_DIRECTORIES.some(
      (directory) => resolvedTarget === `${directory}/resources/bin/${expectedName}`
    )
  }

  protected isSiblingDevLauncherTarget(
    resolvedTarget: string,
    packagedLauncherName: string
  ): boolean {
    if (![packagedLauncherName, DEV_COMMAND_NAME].includes(basename(resolvedTarget))) {
      return false
    }

    const packagedUserDataPath = resolve(this.userDataPath)
    const siblingDevUserDataPath = `${packagedUserDataPath}-dev`
    const siblingDevLauncherDir = resolve(siblingDevUserDataPath, ...DEV_LAUNCHER_DIR)

    // Why: dev builds generate launchers under the sibling `*-dev` profile; packaged Orca must reclaim that command.
    return (
      basename(siblingDevUserDataPath) === `${basename(packagedUserDataPath)}-dev` &&
      isPathInsideOrEqual(siblingDevLauncherDir, resolvedTarget)
    )
  }

  protected isLinuxAppImage(): boolean {
    return this.platform === 'linux' && Boolean(this.appImagePath)
  }

  protected isWindowsPackagedBundledCommand(
    commandPath: string | null,
    launcherPath: string | null
  ): boolean {
    return (
      this.platform === 'win32' &&
      this.isPackaged &&
      commandPath !== null &&
      launcherPath !== null &&
      samePathEntry('win32', commandPath, launcherPath)
    )
  }

  protected async inspectWindowsWrapper(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile()) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca launcher script.`
        })
      }

      if (this.isWindowsPackagedBundledCommand(commandPath, launcherPath)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'installed',
          currentTarget: launcherPath,
          detail: `Registered at ${commandPath}.`
        })
      }

      const currentContent = await readFile(commandPath, 'utf8')
      const expectedContent = buildWindowsForwarder(launcherPath)
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'wrapper',
        supported: true,
        state: currentContent === expectedContent ? 'installed' : 'stale',
        currentTarget: launcherPath,
        detail:
          currentContent === expectedContent
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'wrapper',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from Command Prompt or PowerShell.`
        })
      }
      throw error
    }
  }

  protected buildStatus(args: {
    commandPath: string
    launcherPath: string
    installMethod: CliInstallMethod
    supported: boolean
    state: CliInstallStatus['state']
    currentTarget: string | null
    detail: string | null
  }): CliInstallStatus {
    return {
      platform: this.platform,
      commandName: this.commandName,
      commandPath: args.commandPath,
      pathDirectory: dirname(args.commandPath),
      pathConfigured: false,
      launcherPath: args.launcherPath,
      installMethod: args.installMethod,
      supported: args.supported,
      state: args.state,
      currentTarget: args.currentTarget,
      unsupportedReason: null,
      detail: args.detail
    }
  }
}
