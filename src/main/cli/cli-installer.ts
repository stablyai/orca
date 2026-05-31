/* eslint-disable max-lines -- Why: this file centralizes cross-platform CLI install state, launcher resolution, and PATH registration so the public shell command stays consistent across packaged and development builds. */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CliInstallMethod, CliInstallStatus } from '../../shared/cli-install-types'
import { buildAppImageCliWrapper } from './appimage-cli-wrapper'

const execFileAsync = promisify(execFile)
const DEFAULT_MAC_COMMAND_PATH = '/usr/local/bin/orca'
const DEV_COMMAND_NAME = 'orca-dev'
const LINUX_COMMAND_NAME = 'orca-ide'
const LEGACY_LINUX_COMMAND_NAME = 'orca'
const DEV_LAUNCHER_DIR = ['cli', 'bin']
const WINDOWS_PATH_COMMAND_TIMEOUT_MS = 5_000

type CliInstallerOptions = {
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
  userPathReader?: () => Promise<string | null>
  userPathWriter?: (value: string) => Promise<void>
  /** Why: AppImage reports a stable outer file path via $APPIMAGE while bundled resources live in an ephemeral FUSE mount. */
  appImagePath?: string | null
}

type InstallSpec = {
  commandPath: string
  installMethod: CliInstallMethod
}

export class CliInstaller {
  private readonly platform: NodeJS.Platform
  private readonly isPackaged: boolean
  private readonly userDataPath: string
  private readonly resourcesPath: string
  private readonly execPathValue: string
  private readonly appPathValue: string
  private readonly homePath: string
  private readonly localAppDataPath: string
  private readonly processPathEnv: string | null
  private readonly commandPathOverride: string | null
  private readonly macCommandPath: string
  private readonly privilegedRunner: (command: string) => Promise<void>
  private readonly userPathReader: () => Promise<string | null>
  private readonly userPathWriter: (value: string) => Promise<void>
  private readonly appImagePath: string | null

  private get commandName(): string {
    if (!this.isPackaged && !this.commandPathOverride) {
      // Why: development builds must not claim the production shell command.
      return DEV_COMMAND_NAME
    }
    // Why: packaged Linux uses `orca-ide` to avoid shadowing GNOME Orca's /usr/bin/orca.
    return this.platform === 'linux' ? LINUX_COMMAND_NAME : 'orca'
  }

  constructor(options: CliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.isPackaged = options.isPackaged ?? app.isPackaged
    this.userDataPath = options.userDataPath ?? app.getPath('userData')
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath
    this.execPathValue = options.execPath ?? process.execPath
    this.appPathValue = options.appPath ?? app.getAppPath()
    this.homePath = options.homePath ?? homedir()
    this.localAppDataPath =
      options.localAppDataPath ??
      process.env.LOCALAPPDATA ??
      join(this.homePath, 'AppData', 'Local')
    this.processPathEnv = options.processPathEnv ?? process.env.PATH ?? process.env.Path ?? null
    this.commandPathOverride =
      options.commandPathOverride ?? process.env.ORCA_CLI_INSTALL_PATH ?? null
    // Why: resolved once at construction — existsSync must not run on every
    // getStatus() call (hot path). /usr/local/bin is absent by default on Apple
    // Silicon Macs (Homebrew moved to /opt/homebrew); fall back to ~/.local/bin
    // which is user-writable, requires no elevated permissions, and is the
    // XDG-standard user bin dir already on PATH via shell init on arm64.
    // defaultMacCommandPath is a test seam: it feeds into the existence check
    // so tests can simulate arm64 without relying on the real /usr/local/bin.
    const candidateMacPath = options.defaultMacCommandPath ?? DEFAULT_MAC_COMMAND_PATH
    this.macCommandPath = existsSync(dirname(candidateMacPath))
      ? candidateMacPath
      : join(this.homePath, '.local', 'bin', 'orca')
    this.privilegedRunner = options.privilegedRunner ?? runMacPrivilegedCommand
    this.userPathReader = options.userPathReader ?? (() => readWindowsUserPath())
    this.userPathWriter = options.userPathWriter ?? ((value) => writeWindowsUserPath(value))
    this.appImagePath =
      this.platform === 'linux' && this.isPackaged
        ? (options.appImagePath ?? process.env.APPIMAGE ?? null)
        : null
  }

  async getStatus(): Promise<CliInstallStatus> {
    const spec = this.resolveInstallSpec()
    if (!spec) {
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
      const detail =
        this.isLinuxAppImage() && this.appImagePath
          ? `The AppImage file at ${this.appImagePath} is missing. Move it back or re-run CLI registration from the current AppImage location.`
          : this.isPackaged
            ? 'The bundled CLI launcher is missing from this Orca build.'
            : 'Development mode uses a generated launcher for validation only.'
      return {
        platform: this.platform,
        commandName: this.commandName,
        commandPath: spec.commandPath,
        pathDirectory: dirname(spec.commandPath),
        pathConfigured: false,
        launcherPath: null,
        installMethod: spec.installMethod,
        supported: false,
        state: 'unsupported',
        currentTarget: null,
        unsupportedReason: this.isPackaged ? 'launcher_missing' : 'launch_mode_unavailable',
        detail
      }
    }

    const baseStatus =
      spec.installMethod === 'symlink'
        ? await this.inspectSymlink(spec.commandPath, launcherPath)
        : this.isLinuxAppImage()
          ? await this.inspectAppImageWrapper(spec.commandPath, launcherPath)
          : await this.inspectWindowsWrapper(spec.commandPath, launcherPath)
    const pathDirectory = dirname(spec.commandPath)
    const pathConfigured = await this.isPathConfigured(pathDirectory)
    return this.withPathInfo(baseStatus, pathDirectory, pathConfigured)
  }

  async install(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (!status.supported || !status.commandPath || !status.launcherPath || !status.installMethod) {
      throw new Error(status.detail ?? 'CLI registration is unavailable on this build.')
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to replace non-Orca command at ${status.commandPath}.`)
    }

    // eslint-disable-next-line unicorn/prefer-ternary -- Why: the install path performs async side effects and is easier to audit as an explicit branch than as an awaited ternary.
    if (status.installMethod === 'symlink') {
      await this.installSymlink(status)
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
    } else if (this.isLinuxAppImage()) {
      await this.installAppImageWrapper(status.commandPath, status.launcherPath)
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
    } else {
      // Why: mkdir stays here for the Windows wrapper path — the target dir is
      // user-writable (%LOCALAPPDATA%) so EACCES cannot occur. The symlink path
      // handles its own mkdir inside installSymlink so EACCES triggers the
      // privileged-runner instead of propagating as an unhandled rejection.
      await mkdir(dirname(status.commandPath), { recursive: true })
      await this.installWindowsWrapper(status.commandPath, status.launcherPath)
    }

    if (this.platform === 'win32') {
      // Why: Windows shells discover commands via the user PATH, not by walking
      // arbitrary app install directories. The CLI installer therefore owns the
      // user-scoped PATH entry instead of assuming the desktop installer did it.
      await this.ensureWindowsPathEntry(dirname(status.commandPath))
    }

    return this.getStatus()
  }

  async remove(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (!status.supported || !status.commandPath || !status.launcherPath || !status.installMethod) {
      return status
    }
    if (status.state === 'not_installed') {
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
      if (this.platform === 'win32') {
        await this.removeWindowsPathEntry(dirname(status.commandPath))
        return this.getStatus()
      }
      return status
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to remove non-Orca command at ${status.commandPath}.`)
    }
    if (status.state === 'stale') {
      throw new Error(`Refusing to remove a command not owned by Orca at ${status.commandPath}.`)
    }

    if (status.installMethod === 'symlink') {
      await this.removeSymlink(status.commandPath)
      await this.removeLegacyLinuxCommandIfManaged(status.launcherPath)
    } else {
      await unlink(status.commandPath)
      await this.removeWindowsPathEntry(dirname(status.commandPath))
    }

    return this.getStatus()
  }

  private resolveInstallSpec(): InstallSpec | null {
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

  private resolveCommandPath(): string | null {
    if (this.commandPathOverride) {
      return this.commandPathOverride
    }

    if (!this.isPackaged) {
      // Why: default dev registration is a separate command, while tests and
      // diagnostics can still exercise production paths via commandPathOverride.
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
      // Why: Linux does not have a single privileged global shell-command flow
      // equivalent to macOS's /usr/local/bin integration. ~/.local/bin is the
      // least surprising user-scoped location that many distros already expose.
      // Why `orca-ide`: GNOME Orca (the screen reader) ships /usr/bin/orca on
      // most Linux distros. Using `orca-ide` avoids shadowing that system
      // command, matching the executableName already used for the Electron binary.
      return join(this.homePath, '.local', 'bin', LINUX_COMMAND_NAME)
    }

    if (this.platform === 'win32') {
      return join(this.localAppDataPath, 'Programs', 'Orca', 'bin', 'orca.cmd')
    }

    return null
  }

  private async resolveLauncherPath(): Promise<string | null> {
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

  private async installSymlink(status: CliInstallStatus): Promise<void> {
    try {
      if (status.state === 'installed') {
        return
      }
      if (status.state === 'stale') {
        await unlink(status.commandPath as string)
      }
      // Why: mkdir is placed here (not in install()) so that an EACCES/EPERM
      // failure — e.g. /usr/local/bin absent on Intel Mac — falls into the
      // privileged-runner catch below instead of surfacing as an unhandled
      // rejection that leaves Settings silently showing "not installed".
      await mkdir(dirname(status.commandPath as string), { recursive: true })
      await symlink(status.launcherPath as string, status.commandPath as string)
    } catch (error) {
      if (this.platform !== 'darwin' || !isPermissionError(error)) {
        throw error
      }

      // Why: macOS shell-command registration should behave like VS Code and
      // place a stable symlink in /usr/local/bin instead of rewriting shell rc
      // files. Fallback to an elevated shell command keeps the public command
      // stable even when the app lacks direct write access to that directory.
      await this.privilegedRunner(
        `mkdir -p ${quoteShell(dirname(status.commandPath as string))} && ` +
          `ln -sfn ${quoteShell(status.launcherPath as string)} ${quoteShell(status.commandPath as string)}`
      )
    }
  }

  private async removeSymlink(commandPath: string): Promise<void> {
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

  private async removeLegacyLinuxCommandIfManaged(launcherPath: string | null): Promise<void> {
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

      // Why: after the Linux command rename, the old Orca-owned `orca` symlink
      // would keep shadowing GNOME Orca even though the new command is installed.
      await unlink(legacyCommandPath)
    } catch (error) {
      if (isMissingError(error)) {
        return
      }
      throw error
    }
  }

  private isManagedLegacyLinuxTarget(resolvedTarget: string, launcherPath: string): boolean {
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

    // Why: AppImage upgrades can leave a legacy symlink into a now-gone FUSE
    // mount; the stable AppImage path is not a sibling of that old target.
    return /(?:^|[/\\])resources[/\\]bin[/\\]orca$/.test(resolvedTarget)
  }

  private async installWindowsWrapper(commandPath: string, launcherPath: string): Promise<void> {
    await writeFile(commandPath, buildWindowsForwarder(launcherPath), 'utf8')
  }

  private async installAppImageWrapper(commandPath: string, appImagePath: string): Promise<void> {
    // Why: unlike macOS symlink install, AppImage uses the user-writable Linux
    // command dir and must create it before writing the wrapper file.
    await mkdir(dirname(commandPath), { recursive: true })
    await writeFile(commandPath, buildAppImageCliWrapper(appImagePath), {
      encoding: 'utf8',
      mode: 0o755
    })
  }

  private async inspectAppImageWrapper(
    commandPath: string,
    appImagePath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isFile()) {
        return this.buildStatus({
          commandPath,
          launcherPath: appImagePath,
          installMethod: 'wrapper',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca launcher script.`
        })
      }

      const currentContent = await readFile(commandPath, 'utf8')
      const expectedContent = buildAppImageCliWrapper(appImagePath)
      return this.buildStatus({
        commandPath,
        launcherPath: appImagePath,
        installMethod: 'wrapper',
        supported: true,
        state: currentContent === expectedContent ? 'installed' : 'stale',
        currentTarget: appImagePath,
        detail:
          currentContent === expectedContent
            ? `Registered at ${commandPath}.`
            : `${commandPath} points to a different launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath: appImagePath,
          installMethod: 'wrapper',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from the terminal.`
        })
      }
      throw error
    }
  }

  private async inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isSymbolicLink()) {
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
      const isInstalled = resolvedCurrentTarget === resolvedLauncher
      const isManagedStaleTarget =
        !isInstalled && this.isManagedSymlinkTarget(resolvedCurrentTarget, launcherPath)
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

  private isManagedSymlinkTarget(resolvedTarget: string, launcherPath: string): boolean {
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
      // Why: prior packaged installs can leave a symlink to an older Orca.app
      // resources launcher, but arbitrary user-owned symlinks must not be replaced.
      return /(?:^|[/\\])[^/\\]+\.app[/\\]Contents[/\\]Resources[/\\]bin[/\\][^/\\]+$/.test(
        resolvedTarget
      )
    }

    if (this.platform === 'linux') {
      return /(?:^|[/\\])resources[/\\]bin[/\\][^/\\]+$/.test(resolvedTarget)
    }

    return false
  }

  private isSiblingDevLauncherTarget(
    resolvedTarget: string,
    packagedLauncherName: string
  ): boolean {
    if (![packagedLauncherName, DEV_COMMAND_NAME].includes(basename(resolvedTarget))) {
      return false
    }

    const packagedUserDataPath = resolve(this.userDataPath)
    const siblingDevUserDataPath = `${packagedUserDataPath}-dev`
    const siblingDevLauncherDir = resolve(siblingDevUserDataPath, ...DEV_LAUNCHER_DIR)

    // Why: development builds generate launchers under the sibling `*-dev`
    // profile; packaged Orca must be able to reclaim that public command.
    return (
      basename(siblingDevUserDataPath) === `${basename(packagedUserDataPath)}-dev` &&
      isPathInsideOrEqual(siblingDevLauncherDir, resolvedTarget)
    )
  }

  private isLinuxAppImage(): boolean {
    return this.platform === 'linux' && Boolean(this.appImagePath)
  }

  private async inspectWindowsWrapper(
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

  private buildStatus(args: {
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

  private async isPathConfigured(pathDirectory: string): Promise<boolean> {
    const pathValue =
      this.platform === 'win32' ? await this.userPathReader() : (this.processPathEnv ?? '')
    return splitPathEntries(this.platform, pathValue).some((entry) =>
      samePathEntry(this.platform, entry, pathDirectory)
    )
  }

  private withPathInfo(
    status: CliInstallStatus,
    pathDirectory: string,
    pathConfigured: boolean
  ): CliInstallStatus {
    if (status.state !== 'installed') {
      return {
        ...status,
        pathDirectory,
        pathConfigured
      }
    }

    if (pathConfigured) {
      return {
        ...status,
        pathDirectory,
        pathConfigured
      }
    }

    return {
      ...status,
      pathDirectory,
      pathConfigured,
      detail:
        this.platform === 'linux'
          ? `${status.commandPath} is registered, but ${pathDirectory} is not on PATH for this shell.`
          : `${status.commandPath} is registered. Restart your shell if the command is not visible yet.`
    }
  }

  private async ensureWindowsPathEntry(pathDirectory: string): Promise<void> {
    const current = await this.userPathReader()
    const entries = splitPathEntries('win32', current)
    if (entries.some((entry) => samePathEntry('win32', entry, pathDirectory))) {
      return
    }
    entries.push(pathDirectory)
    await this.userPathWriter(entries.join(';'))
  }

  private async removeWindowsPathEntry(pathDirectory: string): Promise<void> {
    if (this.platform !== 'win32') {
      return
    }
    const current = await this.userPathReader()
    const nextEntries = splitPathEntries('win32', current).filter(
      (entry) => !samePathEntry('win32', entry, pathDirectory)
    )
    await this.userPathWriter(nextEntries.join(';'))
  }
}

async function ensureDevLauncher(args: {
  platform: NodeJS.Platform
  userDataPath: string
  execPath: string
  cliEntryPath: string
  commandName: string
}): Promise<string | null> {
  if (
    !isAbsoluteForPlatform(args.platform, args.execPath) ||
    !isAbsolute(args.cliEntryPath) ||
    !existsSync(args.cliEntryPath)
  ) {
    return null
  }

  const launcherPath = join(
    args.userDataPath,
    ...DEV_LAUNCHER_DIR,
    args.platform === 'win32' ? `${args.commandName}.cmd` : args.commandName
  )
  await mkdir(dirname(launcherPath), { recursive: true })

  // Why: packaged Orca ships real platform launchers under resources/bin, but
  // development builds do not have that stable asset layout. Generating a
  // launcher in userData lets us validate the shell-command flow without
  // changing the packaged registration contract.
  const content =
    args.platform === 'win32'
      ? buildWindowsDevLauncher(args.execPath, args.cliEntryPath, args.userDataPath)
      : buildUnixDevLauncher(args.execPath, args.cliEntryPath, args.userDataPath)
  await writeFile(launcherPath, content, {
    encoding: 'utf8',
    mode: args.platform === 'win32' ? undefined : 0o755
  })
  return launcherPath
}

function buildUnixDevLauncher(
  execPathValue: string,
  cliEntryPath: string,
  userDataPath: string
): string {
  return `#!/usr/bin/env bash
set -euo pipefail
ELECTRON=${quoteShell(execPathValue)}
CLI=${quoteShell(cliEntryPath)}
export ORCA_USER_DATA_PATH=${quoteShell(userDataPath)}
if [ -z "\${ORCA_APP_EXECUTABLE:-}" ]; then
  export ORCA_APP_EXECUTABLE="$ELECTRON"
  export ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1
fi
export ORCA_NODE_OPTIONS="\${NODE_OPTIONS-}"
export ORCA_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$CLI" "$@"
`
}

function buildWindowsDevLauncher(
  execPathValue: string,
  cliEntryPath: string,
  userDataPath: string
): string {
  return `@echo off
setlocal
set "ELECTRON=${escapeWindowsBatchValue(execPathValue)}"
set "CLI=${escapeWindowsBatchValue(cliEntryPath)}"
set "ORCA_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"
if not defined ORCA_APP_EXECUTABLE (
  set "ORCA_APP_EXECUTABLE=%ELECTRON%"
  set "ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1"
)
set "ORCA_NODE_OPTIONS=%NODE_OPTIONS%"
set "ORCA_NODE_REPL_EXTERNAL_MODULE=%NODE_REPL_EXTERNAL_MODULE%"
set NODE_OPTIONS=
set NODE_REPL_EXTERNAL_MODULE=
set ELECTRON_RUN_AS_NODE=1
"%ELECTRON%" "%CLI%" %*
`
}

function buildWindowsForwarder(launcherPath: string): string {
  return `@echo off
setlocal
set "ORCA_LAUNCHER=${escapeWindowsBatchValue(launcherPath)}"
"%ORCA_LAUNCHER%" %*
`
}

function splitPathEntries(platform: NodeJS.Platform, value: string | null): string[] {
  if (!value) {
    return []
  }
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function samePathEntry(platform: NodeJS.Platform, left: string, right: string): boolean {
  return platform === 'win32'
    ? normalizeWindowsPath(left) === normalizeWindowsPath(right)
    : left === right
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const childRelative = relative(parentPath, childPath)
  return childRelative === '' || (!childRelative.startsWith('..') && !isAbsolute(childRelative))
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
}

function escapeWindowsBatchValue(value: string): string {
  return value.replaceAll('"', '""')
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'EACCES' ||
      (error as NodeJS.ErrnoException).code === 'EPERM')
  )
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function runMacPrivilegedCommand(command: string): Promise<void> {
  await execFileAsync('osascript', [
    '-e',
    `do shell script ${quoteAppleScript(command)} with administrator privileges`
  ])
}

function quoteAppleScript(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function isAbsoluteForPlatform(platform: NodeJS.Platform, value: string): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  }
  return isAbsolute(value)
}

async function readWindowsUserPath(): Promise<string | null> {
  const stdout = await runWindowsPathCommand([
    '-NoProfile',
    '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User')"
  ])
  return stdout.trim() || null
}

async function writeWindowsUserPath(value: string): Promise<void> {
  await runWindowsPathCommand([
    '-NoProfile',
    '-Command',
    // Why: PATH registration must stay user-scoped on Windows so the Orca
    // desktop app can manage the public shell command without requiring
    // elevation or mutating machine-wide environment state.
    `[Environment]::SetEnvironmentVariable('Path', ${quotePowerShell(value)}, 'User')`
  ])
}

function runWindowsPathCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile> | null = null
    let settled = false

    const finish = (error: Error | null, stdout = ''): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    }

    // Why: Windows PATH reads/writes back CLI Settings; wedged PowerShell must
    // not keep command registration status or install/remove pending forever.
    const timeout = setTimeout(() => {
      child?.kill()
      finish(
        new Error(`Windows PATH command timed out after ${WINDOWS_PATH_COMMAND_TIMEOUT_MS}ms.`)
      )
    }, WINDOWS_PATH_COMMAND_TIMEOUT_MS)

    try {
      child = execFile(
        'powershell',
        args,
        { encoding: 'utf8', timeout: WINDOWS_PATH_COMMAND_TIMEOUT_MS },
        (error, stdout) => {
          finish(error ?? null, stdout)
        }
      )
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', 'orca')
  }
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', LINUX_COMMAND_NAME)
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', 'orca.cmd')
  }
  return null
}
