/* eslint-disable max-lines -- Why: WSL CLI status/install/remove share one state machine;
   splitting the installer would separate conflict checks from the operations they guard. */
import { execFile } from 'node:child_process'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { getDefaultWslDistro } from '../wsl'
import { CliInstaller } from './cli-installer'
import {
  buildManagedLegacyRemoveCommand,
  buildRegistrationLockPrelude,
  buildSafeRemoveCommand,
  buildSafeReplaceGuard,
  buildWslBridgeScript,
  buildWslLauncher,
  getBridgePathFromCommandPath,
  getPosixDirname,
  getWslBridgeMarker,
  getWslLauncherMarker,
  parseManagedLauncherTarget,
  quoteShell
} from './wsl-cli-scripts'

const MANAGED_MARKER = getWslLauncherMarker()
const BRIDGE_MANAGED_MARKER = getWslBridgeMarker()
const WSL_COMMAND_NAME = 'orca-ide'
const LEGACY_WSL_COMMAND_NAME = 'orca'
const WSL_COMMAND_TIMEOUT_MS = 10_000

function normalizeManagedScriptContent(content: string): string {
  return content.replace(/\n+$/u, '\n')
}

function managedScriptMatches(content: string, expected: string, managed: boolean): boolean {
  return content === expected || (managed && normalizeManagedScriptContent(content) === expected)
}

type WslCliInstallerOptions = {
  platform?: NodeJS.Platform
  distro?: string | null
  hostInstaller?: Pick<CliInstaller, 'getStatus'>
  wslRunner?: (distro: string, command: string) => Promise<string>
}

export type ManagedWslCliRepairResult = {
  changed: boolean
  managed: boolean
  status: CliInstallStatus
}

export class WslCliInstaller {
  private readonly platform: NodeJS.Platform
  private readonly distro: string | null
  private readonly hostInstaller: Pick<CliInstaller, 'getStatus'>
  private readonly wslRunner: (distro: string, command: string) => Promise<string>

  constructor(options: WslCliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.distro = options.distro === undefined ? getDefaultWslDistro() : options.distro
    this.hostInstaller = options.hostInstaller ?? new CliInstaller()
    this.wslRunner = options.wslRunner ?? runWslCommand
  }

  async getStatus(): Promise<CliInstallStatus> {
    const ready = await this.resolveReadyState()
    if ('status' in ready) {
      return ready.status
    }

    const content = await this.readCommandFile(ready.distro, ready.commandPath)
    if (content === null) {
      return this.buildStatus({
        distro: ready.distro,
        commandPath: ready.commandPath,
        launcherPath: ready.launcherPath,
        state: 'not_installed',
        currentTarget: null,
        pathConfigured: ready.pathConfigured,
        detail: `Register ${ready.commandPath} to use Orca from WSL.`
      })
    }

    if (content === 'not_file') {
      return this.buildStatus({
        distro: ready.distro,
        commandPath: ready.commandPath,
        launcherPath: ready.launcherPath,
        state: 'conflict',
        currentTarget: null,
        pathConfigured: ready.pathConfigured,
        detail: `${ready.commandPath} exists but is not an Orca launcher script.`
      })
    }

    const expected = buildWslLauncher(ready.launcherPath, ready.bridgePath)
    const managed = content.includes(MANAGED_MARKER)
    const currentTarget = managed ? parseManagedLauncherTarget(content) : null
    if (managedScriptMatches(content, expected, managed)) {
      const bridgeContent = await this.readCommandFile(ready.distro, ready.bridgePath)
      const expectedBridge = buildWslBridgeScript()
      const bridgeManaged =
        typeof bridgeContent === 'string' && bridgeContent.includes(BRIDGE_MANAGED_MARKER)
      if (
        typeof bridgeContent === 'string' &&
        managedScriptMatches(bridgeContent, expectedBridge, bridgeManaged)
      ) {
        return this.buildStatus({
          distro: ready.distro,
          commandPath: ready.commandPath,
          launcherPath: ready.launcherPath,
          state: 'installed',
          currentTarget,
          pathConfigured: ready.pathConfigured,
          detail: `Registered in ${ready.distro} at ${ready.commandPath}.`
        })
      }

      return this.buildStatus({
        distro: ready.distro,
        commandPath: ready.commandPath,
        launcherPath: ready.launcherPath,
        state: bridgeContent === null || bridgeManaged ? 'stale' : 'conflict',
        currentTarget,
        pathConfigured: ready.pathConfigured,
        detail:
          bridgeContent === null || bridgeManaged
            ? `${ready.commandPath} is missing its PowerShell bridge.`
            : `${ready.bridgePath} exists but is not managed by Orca.`
      })
    }

    // Why: a stale managed launcher is only repairable when its bridge is
    // ours too; reporting conflict here keeps repair from a doomed install
    // whose bridge guard would fail on every startup.
    const bridgeConflict = managed && (await this.isBridgeConflict(ready.distro, ready.bridgePath))
    return this.buildStatus({
      distro: ready.distro,
      commandPath: ready.commandPath,
      launcherPath: ready.launcherPath,
      state: managed && !bridgeConflict ? 'stale' : 'conflict',
      currentTarget,
      pathConfigured: ready.pathConfigured,
      detail: !managed
        ? `${ready.commandPath} exists but is not managed by Orca.`
        : bridgeConflict
          ? `${ready.bridgePath} exists but is not managed by Orca.`
          : `${ready.commandPath} points to a different Orca launcher.`
    })
  }

  private async isBridgeConflict(distro: string, bridgePath: string): Promise<boolean> {
    const bridgeContent = await this.readCommandFile(distro, bridgePath)
    if (bridgeContent === null) {
      return false
    }
    return bridgeContent === 'not_file' || !bridgeContent.includes(BRIDGE_MANAGED_MARKER)
  }

  async repairManagedRegistration(): Promise<ManagedWslCliRepairResult> {
    const status = await this.getStatus()
    if (!status.supported) {
      return { changed: false, managed: false, status }
    }
    if (status.state === 'conflict') {
      // Why: a user-owned bridge conflicts with repair, but the launcher is
      // still Orca-managed and must remain registered for future reconciliation.
      return { changed: false, managed: status.currentTarget !== null, status }
    }

    if (status.state === 'stale') {
      return { changed: true, managed: true, status: await this.install(status) }
    }

    const legacyCommandPath = status.commandPath
      ? `${getPosixDirname(status.commandPath)}/${LEGACY_WSL_COMMAND_NAME}`
      : null
    if (!legacyCommandPath || !this.distro) {
      return { changed: false, managed: status.state === 'installed', status }
    }

    const legacyContent = await this.readCommandFile(this.distro, legacyCommandPath)
    const legacyManaged =
      typeof legacyContent === 'string' && legacyContent.includes(MANAGED_MARKER)
    if (!legacyManaged) {
      return { changed: false, managed: status.state === 'installed', status }
    }

    if (
      status.commandPath &&
      (await this.isBridgeConflict(this.distro, getBridgePathFromCommandPath(status.commandPath)))
    ) {
      // Why: adopting the legacy command would fail install()'s bridge guard
      // forever; stay registered so reconciliation retries after an update.
      return { changed: false, managed: true, status }
    }

    // Why: a legacy-only managed command proves the user opted into WSL CLI
    // registration; install the current name before removing that owned script.
    return { changed: true, managed: true, status: await this.install(status) }
  }

  async install(precomputedStatus?: CliInstallStatus): Promise<CliInstallStatus> {
    // Why: repair passes its fresh probe; re-probing here would double every
    // WSL round trip on the startup reconciliation path.
    const status = precomputedStatus ?? (await this.getStatus())
    if (!status.supported || !status.commandPath || !status.launcherPath) {
      throw new Error(status.detail ?? 'WSL CLI registration is unavailable.')
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to replace non-Orca command at ${status.commandPath}.`)
    }

    // Why: the launcher and PowerShell bridge are one registration; the
    // command replacement stays a single atomic rename (never missing for a
    // concurrent shell) while a bridge copy enables rollback of the pair.
    await this.run(
      this.distro as string,
      [
        'set -euo pipefail',
        `mkdir -p ${quoteShell(status.pathDirectory as string)}`,
        `mkdir -p ${quoteShell(getPosixDirname(getBridgePathFromCommandPath(status.commandPath)))}`,
        buildRegistrationLockPrelude(status.commandPath),
        `command_tmp=${quoteShell(`${status.commandPath}.tmp`)}.$$`,
        `bridge_path=${quoteShell(getBridgePathFromCommandPath(status.commandPath))}`,
        `legacy_command_path=${quoteShell(
          `${getPosixDirname(status.commandPath)}/${LEGACY_WSL_COMMAND_NAME}`
        )}`,
        'bridge_tmp="${bridge_path}.tmp.$$"',
        'bridge_backup="${bridge_tmp}.backup"',
        'bridge_had_original=0',
        'bridge_touched=0',
        'committed=0',
        'rollback() {',
        '  result=$?',
        '  set +e',
        '  if [ "$committed" -ne 1 ]; then',
        `    if [ "$bridge_had_original" -eq 1 ]; then mv -f "$bridge_backup" ${quoteShell(getBridgePathFromCommandPath(status.commandPath))}; elif [ "$bridge_touched" -eq 1 ]; then rm -f ${quoteShell(getBridgePathFromCommandPath(status.commandPath))}; fi`,
        '  fi',
        '  rm -f "$command_tmp" "$bridge_tmp" "$bridge_backup"',
        '  exit "$result"',
        '}',
        'trap rollback EXIT',
        buildSafeReplaceGuard(status.commandPath, MANAGED_MARKER),
        buildSafeReplaceGuard(
          getBridgePathFromCommandPath(status.commandPath),
          BRIDGE_MANAGED_MARKER
        ),
        `cat > "$command_tmp" <<'ORCA_WSL_CLI'`,
        buildWslLauncher(status.launcherPath, getBridgePathFromCommandPath(status.commandPath)),
        'ORCA_WSL_CLI',
        `cat > "$bridge_tmp" <<'ORCA_WSL_BRIDGE'`,
        buildWslBridgeScript(),
        'ORCA_WSL_BRIDGE',
        'chmod 755 "$command_tmp"',
        'chmod 644 "$bridge_tmp"',
        buildSafeReplaceGuard(status.commandPath, MANAGED_MARKER),
        buildSafeReplaceGuard(
          getBridgePathFromCommandPath(status.commandPath),
          BRIDGE_MANAGED_MARKER
        ),
        `if [ -f ${quoteShell(getBridgePathFromCommandPath(status.commandPath))} ]; then cp -p ${quoteShell(getBridgePathFromCommandPath(status.commandPath))} "$bridge_backup"; bridge_had_original=1; fi`,
        `mv -f "$bridge_tmp" ${quoteShell(getBridgePathFromCommandPath(status.commandPath))}`,
        'bridge_touched=1',
        `mv -f "$command_tmp" ${quoteShell(status.commandPath)}`,
        'committed=1',
        'rm -f "$bridge_backup"',
        // Why: the command was renamed to avoid GNOME Orca; remove only the
        // old Orca-managed WSL wrapper after the replacement has committed.
        buildManagedLegacyRemoveCommand('"$legacy_command_path"'),
        'trap - EXIT'
      ].join('\n')
    )
    return this.getStatus()
  }

  async remove(): Promise<CliInstallStatus> {
    const status = await this.getStatus()
    if (!status.supported || !status.commandPath) {
      return status
    }
    const legacyCommandPath = `${getPosixDirname(status.commandPath)}/${LEGACY_WSL_COMMAND_NAME}`
    if (status.state === 'not_installed') {
      // Why: a managed legacy `orca` left behind would later be re-adopted by
      // startup reconciliation as opt-in proof, silently undoing this removal.
      await this.run(
        this.distro as string,
        ['set -euo pipefail', buildManagedLegacyRemoveCommand(quoteShell(legacyCommandPath))].join(
          '\n'
        )
      )
      return status
    }
    if (status.state === 'conflict') {
      throw new Error(`Refusing to remove non-Orca command at ${status.commandPath}.`)
    }

    await this.run(
      this.distro as string,
      buildSafeRemoveCommand(status.commandPath, legacyCommandPath)
    )
    return this.getStatus()
  }

  private async resolveReadyState(): Promise<
    | { status: CliInstallStatus }
    | {
        distro: string
        commandPath: string
        bridgePath: string
        launcherPath: string
        pathConfigured: boolean
      }
  > {
    if (this.platform !== 'win32') {
      return {
        status: this.unsupported(
          'platform_not_supported',
          'WSL CLI registration is only available on Windows.'
        )
      }
    }
    if (!this.distro) {
      return {
        status: this.unsupported('platform_not_supported', 'No WSL distribution is available.')
      }
    }

    const hostStatus = await this.hostInstaller.getStatus()
    if (!hostStatus.launcherPath) {
      return {
        status: this.unsupported(
          hostStatus.unsupportedReason ?? 'launcher_missing',
          hostStatus.detail ?? 'The Windows Orca CLI launcher is missing.'
        )
      }
    }

    const home = (await this.run(this.distro, 'printf %s "$HOME"')).trim()
    if (!home.startsWith('/')) {
      return {
        status: this.unsupported('launcher_missing', 'Unable to resolve the WSL home directory.')
      }
    }

    const interopReady =
      (
        await this.run(
          this.distro,
          '{ command -v powershell.exe >/dev/null 2>&1 || [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; } && command -v wslpath >/dev/null 2>&1 && printf yes || printf no'
        )
      ).trim() === 'yes'
    if (!interopReady) {
      return {
        status: this.unsupported(
          'launcher_missing',
          'WSL Windows interop is unavailable; Orca cannot launch the Windows CLI from WSL.'
        )
      }
    }

    const pathDirectory = `${home}/.local/bin`
    // Why: matches the Linux CLI rename to `orca-ide` (avoids GNOME Orca conflict).
    const commandPath = `${pathDirectory}/${WSL_COMMAND_NAME}`
    const pathConfigured =
      (
        await this.run(
          this.distro,
          `case ":$PATH:" in *:${quoteShell(pathDirectory)}:*) printf yes ;; *) printf no ;; esac`
        )
      ).trim() === 'yes'

    return {
      distro: this.distro,
      commandPath,
      bridgePath: getBridgePathFromCommandPath(commandPath),
      launcherPath: hostStatus.launcherPath,
      pathConfigured
    }
  }

  private async readCommandFile(
    distro: string,
    commandPath: string
  ): Promise<string | 'not_file' | null> {
    const output = await this.run(
      distro,
      [
        `if [ -L ${quoteShell(commandPath)} ]; then`,
        '  printf __ORCA_NOT_FILE__',
        `elif [ ! -e ${quoteShell(commandPath)} ]; then`,
        '  printf __ORCA_MISSING__',
        `elif [ ! -f ${quoteShell(commandPath)} ]; then`,
        '  printf __ORCA_NOT_FILE__',
        'else',
        `  cat ${quoteShell(commandPath)}`,
        'fi'
      ].join('\n')
    )
    if (output === '__ORCA_MISSING__') {
      return null
    }
    if (output === '__ORCA_NOT_FILE__') {
      return 'not_file'
    }
    return output
  }

  private buildStatus(args: {
    distro: string
    commandPath: string
    launcherPath: string
    state: CliInstallStatus['state']
    currentTarget: string | null
    pathConfigured: boolean
    detail: string
  }): CliInstallStatus {
    return {
      platform: 'linux',
      commandName: WSL_COMMAND_NAME,
      commandPath: args.commandPath,
      pathDirectory: getPosixDirname(args.commandPath),
      pathConfigured: args.pathConfigured,
      launcherPath: args.launcherPath,
      installMethod: 'wrapper',
      supported: true,
      state: args.state,
      currentTarget: args.currentTarget,
      unsupportedReason: null,
      detail:
        args.state === 'installed' && !args.pathConfigured
          ? `${args.commandPath} is registered, but ${getPosixDirname(args.commandPath)} is not on PATH in ${args.distro}.`
          : args.detail
    }
  }

  private unsupported(
    unsupportedReason: NonNullable<CliInstallStatus['unsupportedReason']>,
    detail: string
  ): CliInstallStatus {
    return {
      platform: 'linux',
      commandName: WSL_COMMAND_NAME,
      commandPath: null,
      pathDirectory: null,
      pathConfigured: false,
      launcherPath: null,
      installMethod: null,
      supported: false,
      state: 'unsupported',
      currentTarget: null,
      unsupportedReason,
      detail
    }
  }

  private async run(distro: string, command: string): Promise<string> {
    return this.wslRunner(distro, command)
  }
}

async function runWslCommand(distro: string, command: string): Promise<string> {
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

    // Why: WSL CLI status/install/remove backs Settings UI; a wedged wsl.exe
    // process must not leave the command registration flow pending forever.
    const timeout = setTimeout(() => {
      child?.kill()
      finish(new Error(`WSL command timed out after ${WSL_COMMAND_TIMEOUT_MS}ms.`))
    }, WSL_COMMAND_TIMEOUT_MS)

    try {
      child = execFile(
        'wsl.exe',
        ['-d', distro, '--', 'bash', '-lc', buildEncodedWslBashCommand(command)],
        {
          encoding: 'utf8',
          timeout: WSL_COMMAND_TIMEOUT_MS
        },
        (error, stdout) => {
          finish(error ?? null, stdout)
        }
      )
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function buildEncodedWslBashCommand(command: string): string {
  // Why: raw multiline heredocs can be flattened while crossing wsl.exe's
  // Windows command-line boundary. Send one shell-safe line and decode inside WSL.
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  return `set -o pipefail; printf %s ${quoteShell(encoded)} | base64 -d | bash`
}

export const _internals = {
  buildEncodedWslBashCommand,
  buildWslBridgeScript,
  buildWslLauncher,
  getBridgePathFromCommandPath,
  parseManagedLauncherTarget
}
