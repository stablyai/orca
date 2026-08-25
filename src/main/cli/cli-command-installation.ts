import { lstat, mkdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { buildAppImageCliWrapper } from './appimage-cli-wrapper'
import { CliCommandInspection } from './cli-command-inspection'
import { DEV_LAUNCHER_DIR, LEGACY_LINUX_COMMAND_NAME } from './cli-install-constants'
import { buildWindowsForwarder } from './cli-dev-launcher'
import { isMissingError, isPermissionError } from './cli-install-errors'
import { quoteShell } from './cli-install-path-format'

export class CliCommandInstallation extends CliCommandInspection {
  protected async installSymlink(status: CliInstallStatus): Promise<void> {
    try {
      if (status.state === 'installed') {
        return
      }
      if (status.state === 'stale') {
        await unlink(status.commandPath as string)
      }
      // Why: mkdir stays here (not install()) so an EACCES falls into the privileged-runner catch below.
      await mkdir(dirname(status.commandPath as string), { recursive: true })
      await symlink(status.launcherPath as string, status.commandPath as string)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }

      // Why: fall back to an elevated shell to place the /usr/local/bin symlink (VS Code-style) when direct write is denied.
      await this.privilegedRunner(
        `mkdir -p ${quoteShell(dirname(status.commandPath as string))} && ` +
          `ln -sfn ${quoteShell(status.launcherPath as string)} ${quoteShell(status.commandPath as string)}`
      )
    }
  }

  protected async removeSymlink(commandPath: string): Promise<void> {
    try {
      await unlink(commandPath)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }
      await this.privilegedRunner(
        `if [ -L ${quoteShell(commandPath)} ]; then rm ${quoteShell(commandPath)}; fi`
      )
    }
  }

  protected async removeLegacyLinuxCommandIfManaged(launcherPath: string | null): Promise<void> {
    if (this.platform !== 'linux' || this.commandPathOverride || !launcherPath) {
      return
    }

    const legacyCommandPath = join(this.homePath, '.local', 'bin', LEGACY_LINUX_COMMAND_NAME)
    try {
      const stats = await lstat(legacyCommandPath)
      if (!stats.isSymbolicLink()) {
        return
      }

      const currentTarget = await readlink(legacyCommandPath)
      const resolvedCurrentTarget = resolve(dirname(legacyCommandPath), currentTarget)
      if (!this.isManagedLegacyLinuxTarget(resolvedCurrentTarget, launcherPath)) {
        return
      }

      // Why: after the Linux command rename, the old `orca` symlink would keep shadowing GNOME Orca.
      await unlink(legacyCommandPath)
    } catch (error) {
      if (isMissingError(error)) {
        return
      }
      throw error
    }
  }

  protected isManagedLegacyLinuxTarget(resolvedTarget: string, launcherPath: string): boolean {
    const legacyLauncherPath = resolve(dirname(launcherPath), LEGACY_LINUX_COMMAND_NAME)
    if (resolvedTarget === legacyLauncherPath) {
      return true
    }

    if (basename(resolvedTarget) !== LEGACY_LINUX_COMMAND_NAME) {
      return false
    }

    const devLauncherDir = resolve(this.userDataPath, ...DEV_LAUNCHER_DIR)
    const devRelative = relative(devLauncherDir, resolvedTarget)
    if (devRelative && !devRelative.startsWith('..') && !isAbsolute(devRelative)) {
      return true
    }

    // Why: AppImage upgrades can strand a legacy symlink into a now-gone FUSE mount that isn't a sibling of the stable path.
    return /(?:^|[/\\])resources[/\\]bin[/\\]orca$/.test(resolvedTarget)
  }

  protected async installWindowsWrapper(commandPath: string, launcherPath: string): Promise<void> {
    await writeFile(commandPath, buildWindowsForwarder(launcherPath), 'utf8')
  }

  protected async installAppImageWrapper(commandPath: string, appImagePath: string): Promise<void> {
    // Why: the AppImage command dir is user-writable, so create it before writing the wrapper.
    await mkdir(dirname(commandPath), { recursive: true })
    await writeFile(commandPath, buildAppImageCliWrapper(appImagePath), {
      encoding: 'utf8',
      mode: 0o755
    })
  }
}
