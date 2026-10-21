import { TerminalDaemonRestartSeveredParams } from '../../../../shared/rpc-contract/terminal-daemon-params'
import {
  readSeveredDaemonStatus,
  restartSeveredDaemon
} from '../../../daemon/daemon-host-image-state'
import { defineMethod } from '../core'

export const TERMINAL_DAEMON_METHODS = [
  defineMethod({
    name: 'terminalDaemon.severedStatus',
    permission: 'workspace',
    params: null,
    // Why `daemon` is additive: older CLIs read only `severed`.
    handler: async () => ({
      severed: await readSeveredDaemonStatus(),
      // Why lazy: the probe pulls in the daemon provider graph, which the RPC table must not load.
      daemon: await (
        await import('../../../daemon/daemon-liveness-report')
      ).readTerminalDaemonLiveness()
    })
  }),
  defineMethod({
    name: 'terminalDaemon.restartSevered',
    permission: 'host-admin',
    params: TerminalDaemonRestartSeveredParams,
    handler: async (params) => restartSeveredDaemon(params)
  })
]
