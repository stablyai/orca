import { z } from 'zod'
import {
  connectRegisteredSshTarget,
  ensureRegisteredSshConfigTarget,
  getRegisteredSshState,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../../../ssh/ssh-target-registry'
import { defineMethod, type RpcMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'

const SshTarget = z.object({
  targetId: z.string().min(1)
})

const SshConfigTarget = z.object({
  alias: z.string().trim().min(1)
})

function listRegisteredSshTargetSummaries(): { id: string; label: string }[] {
  return listRegisteredSshTargets().map(({ id, label }) => ({ id, label }))
}

export const SSH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'ssh.ensureConfigTarget',
    params: SshConfigTarget,
    handler: async (params) => {
      const { target, created } = await ensureRegisteredSshConfigTarget(params.alias)
      return { target: { id: target.id, label: target.label }, created }
    }
  }),
  defineMethod({
    name: 'ssh.getState',
    params: SshTarget,
    handler: (params) => ({
      state: getPublicSshState(getRegisteredSshState(params.targetId) ?? null)
    })
  }),
  defineMethod({
    name: 'ssh.connect',
    params: SshTarget,
    handler: async (params) => {
      try {
        return { state: getPublicSshState(await connectRegisteredSshTarget(params.targetId)) }
      } catch {
        const state = getRegisteredSshState(params.targetId)
        throw new Error(getPublicSshError(state?.status ?? 'error'))
      }
    }
  }),
  defineMethod({
    name: 'ssh.listTargets',
    params: null,
    // Why: legacy clients can call this method directly, so it must preserve the same HUB-private secret boundary.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listTargetSummaries',
    params: null,
    // Why: paired clients need display identity only; SSH addresses, jump chains, and credentials remain HUB-private.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  })
]
