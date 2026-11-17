import { TerminalLimitUpdateParams } from '../../../../../shared/rpc-contract/terminal/terminal-limit-params'
import { TerminalDaemonRestartSeveredParams } from '../../../../../shared/rpc-contract/terminal/terminal-daemon-params'
import {
  readSeveredDaemonStatus,
  restartSeveredDaemon
} from '../../../../daemon/providers/lifecycle/daemon-host-image-state'
import { getAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'
import { defineMethod } from '../../core'

export const TERMINAL_DAEMON_METHODS = [
  defineMethod({
    name: 'terminalDaemon.limit',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.terminalLimit()
  }),
  defineMethod({
    name: 'terminalDaemon.setLimit',
    permission: 'host-admin',
    params: TerminalLimitUpdateParams,
    handler: async (params, { runtime }) => runtime.terminalLimit(params)
  }),
  defineMethod({
    name: 'terminalDaemon.severedStatus',
    permission: 'workspace',
    params: null,
    // Why `daemon` is additive: older CLIs read only `severed`.
    handler: async () => ({
      severed: await readSeveredDaemonStatus(),
      // Import the probe lazily to avoid loading daemon providers with the RPC table.
      daemon: await (
        await import('../../../../daemon/health/daemon-liveness-report')
      ).readTerminalDaemonLiveness()
    })
  }),
  defineMethod({
    name: 'terminalDaemon.restartSevered',
    permission: 'host-admin',
    params: TerminalDaemonRestartSeveredParams,
    handler: async (params) => restartSeveredDaemon(params)
  }),
  defineMethod({
    name: 'terminalDaemon.stopForUninstall',
    permission: 'host-admin',
    params: null,
    // `orca uninstall` comes here so the app that owns the daemon stops it without respawning one.
    handler: async () => {
      const { stopTerminalDaemonsForUninstall } =
        await import('../../../../daemon/providers/lifecycle/daemon-uninstall-shutdown')
      await stopTerminalDaemonsForUninstall(getAppEnvironment().getPath('userData'))
      return { stopped: true }
    }
  })
]
