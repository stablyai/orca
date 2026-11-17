import {
  CLOUD_SSH_PREPARE_METHOD,
  CLOUD_SSH_TUNNEL_METHOD,
  type CloudSshFailure,
  type CloudSshPrepareResult,
  type CloudSshTunnelResult
} from '../../../../../shared/cloud-ssh'
import { getCloudSshService } from '../../../../cloud-ssh/cloud-ssh-registry'
import { cloudSshFailure } from '../../../../cloud-ssh/cloud-ssh-workspaces'
import { CloudSshParams } from '../../../../../shared/rpc-contract/cloud-ssh-params'
import { defineMethod } from '../../core'

// Headless servers (and the VMs' own orcad) have no Orca Cloud account to act for.
const NOT_HERE: CloudSshFailure = {
  ok: false,
  code: 'not_configured',
  message: 'SSH into Orca Cloud workspaces runs through the Orca desktop app.'
}

export const CLOUD_SSH_METHODS = [
  // `orca ssh-proxy` (ssh's ProxyCommand): wakes the workspace, then opens the loopback forward
  // to its sshd. The CLI pipes ssh's stdio through the port this answers.
  defineMethod({
    name: CLOUD_SSH_TUNNEL_METHOD,
    permission: 'host-admin',
    params: CloudSshParams,
    handler: async ({ workspace }): Promise<CloudSshTunnelResult> => {
      const service = getCloudSshService()
      if (!service) {
        return NOT_HERE
      }
      try {
        const { port } = await service.tunnel(workspace)
        return { ok: true, host: '127.0.0.1', port }
      } catch (error) {
        return cloudSshFailure(error)
      }
    }
  }),
  // `orca ssh`: makes sure this device can log in and answers the ssh invocation.
  defineMethod({
    name: CLOUD_SSH_PREPARE_METHOD,
    permission: 'host-admin',
    params: CloudSshParams,
    handler: async ({ workspace }): Promise<CloudSshPrepareResult> => {
      const service = getCloudSshService()
      if (!service) {
        return NOT_HERE
      }
      try {
        return { ok: true, ...(await service.prepare(workspace)) }
      } catch (error) {
        return cloudSshFailure(error)
      }
    }
  })
]
