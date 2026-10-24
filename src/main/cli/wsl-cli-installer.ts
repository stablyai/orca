import type { CliInstallStatus } from '../../shared/cli-install-types'
import { getDefaultWslDistro } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'
import { CliInstaller } from './cli-installer'
import {
  buildManagedLegacyRemoveCommand,
  buildSafeRemoveCommand,
  buildWslBridgeScript,
  buildWslLauncher,
  getBridgePathFromCommandPath,
  getPosixDirname,
  getWslBridgeMarker,
  getWslLauncherMarker,
  parseManagedLauncherTarget
} from './wsl-cli-scripts'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'
import { buildWslCliInstallCommand } from './wsl-cli-registration-command'
import {
  buildWslCliStatus,
  readWslCliCommandFile,
  resolveReadyWslCliState,
  WslCliLoginPathUnavailableError,
  WslCliUnreachableError,
  type WslCliRun,
  type WslCliRunOptions
} from './wsl-cli-status'

const MANAGED_MARKER = getWslLauncherMarker()
const BRIDGE_MANAGED_MARKER = getWslBridgeMarker()
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
  wslRunner?: WslCliRun
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
  private readonly wslRunner: WslCliRun

  constructor(options: WslCliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.distro = options.distro === undefined ? getDefaultWslDistro() : options.distro
    this.hostInstaller = options.hostInstaller ?? new CliInstaller()
    this.wslRunner = options.wslRunner ?? runWslCommand
  }

  async getStatus(): Promise<CliInstallStatus> {
    const ready = await resolveReadyWslCliState({
      platform: this.platform,
      distro: this.distro,
      getHostStatus: () => this.hostInstaller.getStatus(),
      run: (distro, command, options) => this.run(distro, command, options)
    })
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

    // A foreign bridge blocks repair even when the launcher is managed.
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
      // Keep managed launchers registered even when a foreign bridge blocks repair.
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
      // Preserve opt-in for later reconciliation without attempting a blocked bridge install.
      return { changed: false, managed: true, status }
    }

    // The managed legacy command proves opt-in; replace it only after installing the current name.
    return { changed: true, managed: true, status: await this.install(status) }
  }

  async install(precomputedStatus?: CliInstallStatus): Promise<CliInstallStatus> {
    // Reuse repair's fresh probe to avoid duplicate WSL round trips.
    const status = precomputedStatus ?? (await this.getStatus())
    if (!status.supported || !status.commandPath || !status.launcherPath) {
      throw new Error(status.detail ?? 'WSL CLI registration is unavailable.')
    }
    if (status.state === 'conflict') {
      throw new Error(
        `Refusing to replace non-Orca command at ${status.commandPath}. Remove it and register again if it is no longer needed.`
      )
    }

    await this.run(
      this.distro as string,
      buildWslCliInstallCommand({
        ...status,
        commandPath: status.commandPath,
        launcherPath: status.launcherPath
      })
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
      // A leftover managed legacy command would let startup reconciliation undo removal.
      await this.run(
        this.distro as string,
        [
          'set -eu',
          buildManagedLegacyRemoveCommand(quotePosixShellDoubleQuotedApostrophe(legacyCommandPath))
        ].join('\n')
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

  private async readCommandFile(
    distro: string,
    commandPath: string
  ): Promise<(string & {}) | 'not_file' | null> {
    return readWslCliCommandFile(
      (targetDistro, command, options) => this.run(targetDistro, command, options),
      distro,
      commandPath
    )
  }

  private buildStatus(args: {
    distro: string
    commandPath: string
    launcherPath: string
    state: CliInstallStatus['state']
    currentTarget: string | null
    pathConfigured: boolean | null
    detail: string
  }): CliInstallStatus {
    return buildWslCliStatus(args)
  }

  private async run(distro: string, command: string, options?: WslCliRunOptions): Promise<string> {
    return this.wslRunner(distro, command, options)
  }
}

async function runWslCommand(
  distro: string,
  command: string,
  options: WslCliRunOptions = {}
): Promise<string> {
  // Only PATH checks need the login probe; slow profiles must not consume other commands' budgets.
  const loginPath = options.loginPath ?? 'none'
  const result = await runWslProcess({
    distro,
    loginPath,
    script: command,
    // Opaque generated payloads are POSIX; the process guard cannot infer their shell dialect.
    shell: 'sh',
    timeoutMs: WSL_COMMAND_TIMEOUT_MS
  })
  // A timeout also leaves the environment unresolved; report the more specific diagnosis first.
  if (result.timedOut) {
    throw new WslCliUnreachableError(distro)
  }
  // An unresolved login PATH cannot establish whether the user's command directory is on PATH.
  if (loginPath === 'preferred' && !result.environmentResolved) {
    throw new WslCliLoginPathUnavailableError(distro)
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `WSL command failed with exit code ${result.code}.`)
  }
  return result.stdout
}

export const _internals = {
  buildWslBridgeScript,
  buildWslLauncher,
  getBridgePathFromCommandPath,
  parseManagedLauncherTarget
}
