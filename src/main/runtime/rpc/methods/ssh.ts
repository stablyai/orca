import {
  connectRegisteredSshTarget,
  getRegisteredSshState,
  getRegisteredSshTargetMutations,
  getSshConnectionManager,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets,
  SshTargetManagementUnservedError
} from '../../../ssh/targets/ssh-target-registry'
import { isManagedOrcadSshTarget } from '../../../ssh/connection/ssh-connection-store'
import { browseSshDirectory } from '../../../ssh/ssh-remote-directory-browse'
import { defineMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import type { SshTarget as SshTargetRecord, SshTargetSummary } from '../../../../shared/ssh-types'
import { isRemoteCliControlAllowed } from '../../../../shared/ssh-remote-cli-control'
import type {
  SshEditableTarget,
  SshEditableTargetField,
  SshEditableTargetInput
} from '../../../../shared/ssh-target-management'
import {
  SshBrowseDir,
  SshConnect,
  SshTarget,
  SshTargetAdd,
  SshTargetUpdate
} from '../../../../shared/rpc-contract/ssh-params'

// Keep generation optional so older server rows still key by target id.
function toSshTargetSummary({ id, label, generation }: SshTargetRecord): SshTargetSummary {
  const state = getRegisteredSshState(id)
  const remotePlatform = state?.remotePlatform
  return {
    id,
    label,
    ...(generation === undefined ? {} : { generation }),
    connected: state?.status === 'connected',
    ...(state?.status === undefined ? {} : { connectionStatus: state.status }),
    ...(remotePlatform === undefined ? {} : { remotePlatform })
  }
}

function listRegisteredSshTargetSummaries(): SshTargetSummary[] {
  return listRegisteredSshTargets().map(toSshTargetSummary)
}

// Allowlist editable fields so new/stray SshTarget keys cannot leak to paired clients; satisfies enforces parity.
function pickSshEditableFields(source: SshEditableTargetInput): SshEditableTargetInput {
  return {
    label: source.label,
    configHost: source.configHost,
    host: source.host,
    port: source.port,
    username: source.username,
    identityFile: source.identityFile,
    identityAgent: source.identityAgent,
    identitiesOnly: source.identitiesOnly,
    gssapiAuthentication: source.gssapiAuthentication,
    proxyCommand: source.proxyCommand,
    jumpHost: source.jumpHost,
    relayGracePeriodSeconds: source.relayGracePeriodSeconds,
    systemSshConnectionReuse: source.systemSshConnectionReuse,
    systemSshProxyConnectionReuse: source.systemSshProxyConnectionReuse,
    remoteRuntime: source.remoteRuntime,
    allowRemoteCliControl: source.allowRemoteCliControl
  } satisfies Record<SshEditableTargetField, unknown>
}

// Send/save an explicit boolean for clients predating the default flip, which read omission as off.
function withExplicitRemoteCliControl(input: SshEditableTargetInput): SshEditableTargetInput {
  return { ...input, allowRemoteCliControl: input.allowRemoteCliControl ?? false }
}

function toSshEditableTarget(target: SshTargetRecord): SshEditableTarget {
  return {
    ...pickSshEditableFields(target),
    allowRemoteCliControl: isRemoteCliControlAllowed(target),
    ...toSshTargetSummary(target),
    ...(target.source === undefined ? {} : { source: target.source }),
    ...(isManagedOrcadSshTarget(target) ? { managedServer: true as const } : {})
  }
}

export const SSH_METHODS = [
  defineMethod({
    name: 'ssh.getState',
    permission: 'workspace',
    params: SshTarget,
    handler: (params) => ({
      state: getPublicSshState(getRegisteredSshState(params.targetId) ?? null)
    })
  }),
  defineMethod({
    name: 'ssh.connect',
    permission: 'host-admin',
    params: SshConnect,
    handler: async (params) => {
      try {
        const state = await connectRegisteredSshTarget(params.targetId, {
          automatic: params.automatic === true
        })
        return { state: getPublicSshState(state) }
      } catch {
        const state = getRegisteredSshState(params.targetId)
        throw new Error(getPublicSshError(state?.status ?? 'error'))
      }
    }
  }),
  defineMethod({
    name: 'ssh.listTargets',
    permission: 'workspace',
    params: null,
    // Legacy direct calls must preserve the HUB-private secret boundary too.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listTargetSummaries',
    permission: 'workspace',
    params: null,
    // Expose only display identity; SSH addresses, jump chains and credentials stay HUB-private.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    permission: 'workspace',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  }),
  // Workspace callers can already edit this host's SSH config via terminals; target management grants equivalent power.
  defineMethod({
    name: 'ssh.listEditableTargets',
    permission: 'workspace',
    params: null,
    handler: () => ({ targets: listRegisteredSshTargets().map(toSshEditableTarget) })
  }),
  defineMethod({
    name: 'ssh.addTarget',
    permission: 'workspace',
    params: SshTargetAdd,
    handler: (params) => {
      const result = getRegisteredSshTargetMutations().add({
        ...withExplicitRemoteCliControl(params.target),
        source: 'manual'
      })
      return {
        target: toSshEditableTarget(result.target),
        repoReadoptions: result.repoReadoptions
      }
    }
  }),
  defineMethod({
    name: 'ssh.updateTarget',
    permission: 'workspace',
    params: SshTargetUpdate,
    handler: (params) => {
      // Replace semantics clear omitted optional fields, matching SSH settings.
      const updated = getRegisteredSshTargetMutations().update(params.targetId, {
        ...pickSshEditableFields(withExplicitRemoteCliControl(params.target)),
        source: 'manual'
      })
      if (!updated) {
        throw new Error(`SSH target not found: ${params.targetId}`)
      }
      return { target: toSshEditableTarget(updated) }
    }
  }),
  defineMethod({
    name: 'ssh.removeTarget',
    permission: 'workspace',
    params: SshTarget,
    handler: async (params) => {
      await getRegisteredSshTargetMutations().remove(params.targetId)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'ssh.browseDir',
    permission: 'workspace',
    params: SshBrowseDir,
    handler: (params) => {
      const manager = getSshConnectionManager()
      if (!manager) {
        throw new SshTargetManagementUnservedError()
      }
      return browseSshDirectory(manager, params.targetId, params.dirPath)
    }
  })
]
