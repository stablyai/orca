import { TerminalLimitUpdateParams } from '../../../../shared/rpc-contract/terminal-limit-params'
import { TerminalDaemonRestartSeveredParams } from '../../../../shared/rpc-contract/terminal-daemon-params'
import {
  readSeveredDaemonStatus,
  restartSeveredDaemon
} from '../../../daemon/daemon-host-image-state'
import { defineMethod } from '../core'

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
        await import('../../../daemon/daemon-liveness-report')
      ).readTerminalDaemonLiveness(),
      // Additive like `daemon`: true while a kept daemon cannot start terminals and fresh ones run in-process.
      freshSpawnsInProcess: (
        await import('../../../daemon/daemon-provider-state')
      ).freshSpawnsRunInProcess()
    })
  }),
  defineMethod({
    name: 'terminalDaemon.restartSevered',
    permission: 'host-admin',
    params: TerminalDaemonRestartSeveredParams,
    handler: async (params) => restartSeveredDaemon(params)
  })
]
