import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { resolveUnixShellPath } from '../providers/local-pty-utils'
import { resolvePtyShellPath, shellPathSupportsPtyStartupBarrier } from './shell-ready'
import { shellReadyMarkerComesFromLineEditor } from '../../shared/shell-ready-marker-timing'
import { PREPARED_AGENT_LAUNCH_PROTOCOL_VERSION } from './daemon-protocol-version'
import type {
  PreparedAgentLaunchRequest,
  PreparedAgentSpawn
} from './prepared-agent-launch-protocol'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import { holdPassiveRestoreOfStoppedWslDistro } from './daemon-wsl-passive-restore-hold'
import { resolveWslSessionContext } from './wsl-session-context'

export abstract class DaemonPtyPreparedLaunch extends DaemonPtyDaemonRecovery {
  async prepareAgentLaunchSpawn(options: PtySpawnOptions): Promise<PreparedAgentSpawn> {
    if (!options.sessionId || !options.isNewSession) {
      throw new Error('agent_session_operation_invalid')
    }
    await holdPassiveRestoreOfStoppedWslDistro(options, resolveWslSessionContext(options)?.distro)
    await this.replaceUnhealthyMacResolverDaemonBeforeNewPty()
    await this.replaceStaleBundleDaemonBeforeNewPty()
    await this.replaceSeveredMacTccDaemonBeforeNewPty()
    await this.ensureConnected()
    if (!this.supportsPreparedAgentLaunches()) {
      throw new Error('prepared_agent_launch_unsupported')
    }
    const opts = this.withHistoryIsolation(options)
    const shell =
      process.platform !== 'win32' && opts.command
        ? resolveUnixShellPath(opts.shellOverride || resolvePtyShellPath(opts.env ?? {}))
        : ''
    return {
      sessionId: options.sessionId,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      command: opts.command,
      startupCommandDelivery:
        opts.command && shellReadyMarkerComesFromLineEditor(shell)
          ? 'shell-ready'
          : opts.startupCommandDelivery,
      launchAgent: opts.launchAgent,
      shellOverride: opts.shellOverride,
      terminalShellArgs: opts.terminalShellArgs,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
      terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation,
      shellReadySupported: shellPathSupportsPtyStartupBarrier(shell),
      startupIngress: opts.startupIngress,
      spawnIntent: opts.spawnIntent
    }
  }

  supportsPreparedAgentLaunches(): boolean {
    return this.protocolVersion >= PREPARED_AGENT_LAUNCH_PROTOCOL_VERSION
  }

  async preparedAgentLaunch(payload: PreparedAgentLaunchRequest['payload']): Promise<unknown> {
    if (!this.supportsPreparedAgentLaunches()) {
      throw new Error('prepared_agent_launch_unsupported')
    }
    await this.ensureConnected()
    return this.client.request('preparedAgentLaunch', payload)
  }
}
