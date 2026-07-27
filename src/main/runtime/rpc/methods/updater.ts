import { defineMethod, type RpcMethod } from '../core'
import { z } from 'zod'
import {
  checkRemoteServerUpdater,
  downloadRemoteServerUpdater,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdater,
  waitRemoteServerUpdater
} from '../../remote-server-updater'

const UpdaterWaitParams = z.object({
  afterRevision: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(1).max(30_000)
})

/**
 * RPC methods that expose the running app's updater to the CLI and paired clients.
 * Deliberately not on the mobile allowlist, so only the local CLI and the trusted
 * SSH relay can drive check/download/install.
 */
export const UPDATER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'updater.getStatus',
    params: null,
    handler: (_params, { runtime }) => getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.wait',
    params: UpdaterWaitParams,
    // Why: long-poll for the next status revision so the CLI reacts to updater
    // events without high-frequency polling over local or remote runtimes.
    handler: (params, { runtime, signal }) =>
      waitRemoteServerUpdater(
        runtime.getRuntimeId(),
        params.afterRevision,
        params.timeoutMs,
        signal
      )
  }),
  defineMethod({
    name: 'updater.check',
    params: z.object({
      includePrerelease: z.boolean().optional(),
      includePerfPrerelease: z.boolean().optional()
    }),
    handler: (params, { runtime }) => checkRemoteServerUpdater(runtime.getRuntimeId(), params)
  }),
  defineMethod({
    name: 'updater.download',
    params: null,
    handler: (_params, { runtime }) => downloadRemoteServerUpdater(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.install',
    params: null,
    handler: (_params, { runtime }) => installRemoteServerUpdater(runtime.getRuntimeId())
  })
]
