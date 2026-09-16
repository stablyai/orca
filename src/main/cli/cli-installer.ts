import { mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import {
  pruneAppImageExtractedRoots,
  removeAppImageInstalledPayloads
} from './appimage-extraction-pruning'
import { withAppImageRegistrationLock } from './appimage-registration-lock'
import {
  isAppImageInstalledLauncherCurrent,
  isAppImageInstalledLauncherOwnedBySibling,
  resolveAppImageNamespacePath
} from './appimage-extracted-root'
import { isAppImageStableLauncherReady } from './appimage-stable-launcher'
import { CliPathRegistration } from './cli-path-registration'

export class CliInstaller extends CliPathRegistration {
  isAppImageRegistrationOwnedBySibling(status: CliInstallStatus): boolean {
    if (
      status.currentTarget !== status.launcherPath ||
      !isAppImageStableLauncherReady(this.appImageCacheRootPath)
    ) {
      return false
    }
    const extractionOptions = this.appImageExtractionOptions()
    return Boolean(
      extractionOptions && isAppImageInstalledLauncherOwnedBySibling(extractionOptions)
    )
  }

  async getStatus(): Promise<CliInstallStatus> {
    const defaultSpec = this.resolveInstallSpec()
    if (!defaultSpec) {
      return {
        platform: this.platform,
        commandName: this.commandName,
        commandPath: null,
        pathDirectory: null,
        pathConfigured: false,
        launcherPath: null,
        installMethod: null,
        supported: false,
        state: 'unsupported',
        currentTarget: null,
        unsupportedReason: 'platform_not_supported',
        detail: 'CLI registration is not implemented on this platform.'
      }
    }

    const launcherPath = await this.resolveLauncherPath()
    if (!launcherPath) {
      const detail = this.hasUnverifiedAppImageRuntime
        ? 'Orca could not verify the inherited AppImage runtime identity, so CLI registration is unavailable.'
        : this.isLinuxAppImage() && this.appImagePath
          ? `The AppImage file at ${this.appImagePath} is missing. Move it back or re-run CLI registration from the current AppImage location.`
          : this.isPackaged
            ? 'The bundled CLI launcher is missing from this Orca build.'
            : 'Development mode uses a generated launcher for validation only.'
      return {
        platform: this.platform,
        commandName: this.commandName,
        commandPath: defaultSpec.commandPath,
        pathDirectory: dirname(defaultSpec.commandPath),
        pathConfigured: false,
        launcherPath: null,
        installMethod: defaultSpec.installMethod,
        supported: false,
        state: 'unsupported',
        currentTarget: null,
        unsupportedReason: this.isPackaged ? 'launcher_missing' : 'launch_mode_unavailable',
        detail
      }
    }

    return this.getStatusForLauncher(launcherPath)
  }

  private async getStatusForLauncher(launcherPath: string): Promise<CliInstallStatus> {
    const defaultSpec = this.resolveInstallSpec()
    if (!defaultSpec) {
      throw new Error('CLI registration is not implemented on this platform.')
    }
    const spec = await this.resolveActiveInstallSpec(defaultSpec, launcherPath)
    const inspectedStatus =
      spec.installMethod === 'symlink'
        ? await this.inspectSymlink(spec.commandPath, launcherPath)
        : await this.inspectWindowsWrapper(spec.commandPath, launcherPath)
    const extractionOptions = this.appImageExtractionOptions()
    const baseStatus =
      inspectedStatus.state === 'installed' &&
      extractionOptions &&
      !isAppImageInstalledLauncherCurrent(extractionOptions)
        ? {
            ...inspectedStatus,
            state: 'stale' as const,
            detail: `${spec.commandPath} does not point to the current Orca AppImage payload.`
          }
        : inspectedStatus
    const pathDirectory = dirname(spec.commandPath)
    const pathProbe = await this.probePathConfiguration(pathDirectory)
    return this.withPathInfo(baseStatus, pathDirectory, pathProbe)
  }

  async install(): Promise<CliInstallStatus> {
    return this.runAppImageRegistrationOperation(() => this.installUnlocked())
  }

  private async installUnlocked(): Promise<CliInstallStatus> {
    const initialStatus = await this.getStatus()
    if (
      !initialStatus.supported ||
      !initialStatus.commandPath ||
      !initialStatus.launcherPath ||
      !initialStatus.installMethod
    ) {
      throw new Error(initialStatus.detail ?? 'CLI registration is unavailable on this build.')
    }
    if (initialStatus.state === 'conflict') {
      throw new Error(
        `Refusing to replace non-Orca command at ${initialStatus.commandPath}. Remove it and register again if it is no longer needed.`
      )
    }
    const extractedRoot = await this.ensureLinuxAppImagePayload()
    const status = extractedRoot
      ? await this.getStatusForLauncher(extractedRoot.stableLauncherPath)
      : initialStatus
    if (!status.supported || !status.commandPath || !status.launcherPath || !status.installMethod) {
      throw new Error(status.detail ?? 'CLI registration is unavailable on this build.')
    }
    if (status.state === 'conflict') {
      throw new Error(
        `Refusing to replace non-Orca command at ${status.commandPath}. Remove it and register again if it is no longer needed.`
      )
    }

    // eslint-disable-next-line unicorn/prefer-ternary -- Why: the install path performs async side effects and is easier to audit as an explicit branch than as an awaited ternary.
    if (status.installMethod === 'symlink') {
      await this.installSymlink(status)
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
    } else if (this.isWindowsPackagedBundledCommand(status.commandPath, status.launcherPath)) {
      // Why: packaged Windows already ships resources/bin/orca.exe; registration only owns the PATH entry.
    } else {
      // Why: the Windows wrapper dir is user-writable (%LOCALAPPDATA%), so mkdir here can't hit EACCES.
      await mkdir(dirname(status.commandPath), { recursive: true })
      await this.installWindowsWrapper(status.commandPath, status.launcherPath)
    }

    if (this.platform === 'win32') {
      // Why: Windows shells find commands via user PATH, so the installer owns that entry, not the desktop installer.
      await this.ensureWindowsPathEntry(dirname(status.commandPath))
    }
    if (extractedRoot) {
      await pruneAppImageExtractedRoots(extractedRoot.rootPath)
    }

    return extractedRoot
      ? this.getStatusForLauncher(extractedRoot.stableLauncherPath)
      : this.getStatus()
  }

  async remove(): Promise<CliInstallStatus> {
    return this.runAppImageRegistrationOperation(() => this.removeUnlocked())
  }

  private async removeUnlocked(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (!status.supported || !status.commandPath || !status.launcherPath || !status.installMethod) {
      await this.removeLinuxAppImagePayloads()
      return status
    }
    if (status.state === 'not_installed') {
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
      if (this.platform === 'win32') {
        await this.removeWindowsPathEntry(dirname(status.commandPath))
        return this.getStatus()
      }
      await this.removeLinuxAppImagePayloads()
      return status
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to remove non-Orca command at ${status.commandPath}.`)
    }
    if (status.state === 'stale' && status.installMethod !== 'symlink') {
      throw new Error(`Refusing to remove a command not owned by Orca at ${status.commandPath}.`)
    }

    if (status.state === 'stale' && this.isAppImageRegistrationOwnedBySibling(status)) {
      await this.removeLinuxAppImagePayloads()
      return this.getStatus()
    }

    if (status.installMethod === 'symlink') {
      await this.removeSymlink(status.commandPath)
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
    } else if (this.isWindowsPackagedBundledCommand(status.commandPath, status.launcherPath)) {
      await this.removeWindowsPathEntry(dirname(status.commandPath))
    } else {
      await unlink(status.commandPath)
      await this.removeWindowsPathEntry(dirname(status.commandPath))
    }

    await this.removeLinuxAppImagePayloads()
    return this.getStatus()
  }

  private async removeLinuxAppImagePayloads(): Promise<void> {
    const extractionOptions = this.appImageExtractionOptions()
    if (this.isLinuxAppImage() && extractionOptions) {
      await removeAppImageInstalledPayloads(resolveAppImageNamespacePath(extractionOptions))
    }
  }

  private runAppImageRegistrationOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.isLinuxAppImage()
      ? withAppImageRegistrationLock(this.appImageCacheRootPath, operation)
      : operation()
  }
}
