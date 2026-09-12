import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { collectOrcadTerminalCensus } from '../../../orcad/orcad-terminal-census'
import {
  requestOrcadDecommission,
  requestOrcadManagedDecommission,
  requestOrcadManagedStopCancellation,
  getOrcadManagedStopIdentity
} from '../../../orcad/orcad-decommission'
import { OrcadManagedDecommissionParamsSchema } from '../../../../shared/orcad-managed-decommission'
import { OrcadManagedStopRequestSchema } from '../../../../shared/orcad-managed-stop-request'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { OrcadDecommissionParamsSchema } from '../../../../shared/orcad-decommission'
import { z } from 'zod'
import { collectCachedOrcadHealth } from '../../../orcad/orcad-health'

export const STATUS_METHODS = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  }),
  defineMethod({
    name: 'orcad.health',
    params: null,
    handler: () => collectCachedOrcadHealth(getAppEnvironment().getVersion())
  }),
  defineMethod({
    name: 'orcad.terminalCensus',
    params: z.object({ activatedAt: z.number().finite().nonnegative() }),
    handler: (params) => collectOrcadTerminalCensus(params.activatedAt)
  }),
  defineMethod({
    name: 'orcad.managedStopIdentity',
    params: null,
    handler: (_params, { runtime }) =>
      getOrcadManagedStopIdentity(runtime.getRuntimeId(), getAppEnvironment().getVersion())
  }),
  defineMethod({
    name: 'orcad.decommissionManagedIfIdle',
    params: OrcadManagedDecommissionParamsSchema,
    handler: (params, { runtime }) =>
      requestOrcadManagedDecommission(
        params,
        getAppEnvironment().getVersion(),
        runtime.getRuntimeId()
      )
  }),
  defineMethod({
    name: 'orcad.decommissionIfIdle',
    params: OrcadDecommissionParamsSchema,
    handler: (params) =>
      requestOrcadDecommission(
        params.version,
        getAppEnvironment().getVersion(),
        params.transactionId
      )
  }),
  defineMethod({
    name: 'orcad.cancelPreparedStop',
    params: OrcadManagedStopRequestSchema,
    handler: (params, { runtime }) =>
      requestOrcadManagedStopCancellation(
        params,
        getAppEnvironment().getVersion(),
        runtime.getRuntimeId()
      )
  })
]
