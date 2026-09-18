import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../../../ssh/ssh-target-registry'
import { findCoLocatedEnvironmentIds } from '../../../ssh/ssh-target-environment-colocation'
import { defineMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { listEnvironments } from '../../../../shared/runtime-environment-store'
import type {
  SshTarget as RegisteredSshTarget,
  SshTargetSummary
} from '../../../../shared/ssh-types'
import { SshTarget } from '../../../../shared/rpc-contract/ssh-params'

// Why best-effort: a headless server has no pairing store, and a slow resolver must never hold
// up a listing whose other fields are already known.
async function coLocatedEnvironmentIds(
  targets: readonly RegisteredSshTarget[]
): Promise<Map<string, string>> {
  try {
    const environments = listEnvironments(getAppEnvironment().getPath('userData'))
    return await findCoLocatedEnvironmentIds(targets, environments)
  } catch {
    return new Map()
  }
}

// Why: `generation` stays optional on the wire — an old server simply omits it and its rows key on target id alone.
async function listRegisteredSshTargetSummaries(): Promise<SshTargetSummary[]> {
  const targets = listRegisteredSshTargets()
  const coLocated = await coLocatedEnvironmentIds(targets)
  return targets.map(({ id, label, generation }) => {
    const state = getRegisteredSshState(id)
    const remotePlatform = state?.remotePlatform
    const coLocatedEnvironmentId = coLocated.get(id)
    return {
      id,
      label,
      ...(generation === undefined ? {} : { generation }),
      connected: state?.status === 'connected',
      ...(state?.status === undefined ? {} : { connectionStatus: state.status }),
      ...(remotePlatform === undefined ? {} : { remotePlatform }),
      ...(coLocatedEnvironmentId === undefined ? {} : { coLocatedEnvironmentId })
    }
  })
}

export const SSH_METHODS = [
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
    handler: async () => ({ targets: await listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listTargetSummaries',
    params: null,
    // Why: paired clients need display identity only; SSH addresses, jump chains, and credentials remain HUB-private.
    handler: async () => ({ targets: await listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  })
]
