import { errorMessage } from '../../../../shared/errors/error-message'
import { SshTarget } from '../../../../shared/rpc-contract/ssh/ssh-params'
import {
  getSshConnectionManager,
  listRegisteredSshTargets,
  markSshTestProbe,
  unmarkSshTestProbe
} from '../../../ssh/targets/ssh-target-registry'
import { getPublicSshState } from '../../hosts/platform-probe/public-ssh-state'
import { defineMethod } from '../core'

export const SSH_TEST_CONNECTION_METHODS = [
  defineMethod({
    name: 'ssh.testConnection',
    permission: 'host-admin',
    params: SshTarget,
    handler: async (params) => {
      const manager = getSshConnectionManager()
      const target = listRegisteredSshTargets().find(
        (candidate) => candidate.id === params.targetId
      )
      if (!target || !manager) {
        throw new Error(`SSH target "${params.targetId}" not found`)
      }
      // Why: mirror the main-side probe — borrow the transport (reusing a
      // live one), read its state, then tear it down; broadcasts stay
      // suppressed for the whole probe via the registry mark.
      markSshTestProbe(params.targetId)
      try {
        const connection = await manager.connect(target)
        const state = connection.getState()
        await manager.disconnect(params.targetId)
        return { success: true, state: getPublicSshState(state) }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      } finally {
        unmarkSshTestProbe(params.targetId)
      }
    }
  })
]
