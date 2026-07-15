import { z } from 'zod'
import {
  addRegisteredSshTarget,
  connectRegisteredSshTarget,
  getSshConnectionManager,
  getRegisteredSshState,
  importRegisteredSshConfig,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../../../ipc/ssh'
import { browseSshDirectory } from '../../../ipc/ssh-browse'
import { defineMethod, type RpcMethod } from '../core'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../../../shared/ssh-types'

const SshTarget = z.object({
  targetId: z.string().min(1)
})

const ManualSshTarget = z
  .object({
    label: z.string().trim().min(1).max(200),
    configHost: z.string().trim().min(1).max(512).optional(),
    host: z.string().trim().min(1).max(512),
    port: z.number().int().min(1).max(65_535),
    username: z.string().trim().max(200),
    identityFile: z.string().trim().min(1).max(4096).optional(),
    relayGracePeriodSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
      .refine(
        (value) => value === 0 || value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
        `Relay grace period must be 0 or at least ${MIN_SSH_RELAY_GRACE_PERIOD_SECONDS}`
      )
      .optional(),
    systemSshConnectionReuse: z.boolean().optional()
  })
  .strict()

const SshBrowse = SshTarget.extend({
  dirPath: z.string().min(1).max(4096)
})

export const SSH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'ssh.getState',
    params: SshTarget,
    handler: (params) => ({ state: getRegisteredSshState(params.targetId) ?? null })
  }),
  defineMethod({
    name: 'ssh.connect',
    params: SshTarget,
    handler: async (params) => ({ state: await connectRegisteredSshTarget(params.targetId) })
  }),
  defineMethod({
    name: 'ssh.listTargets',
    params: null,
    handler: () => ({ targets: listRegisteredSshTargets() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  }),
  defineMethod({
    name: 'ssh.addTarget',
    params: z.object({ target: ManualSshTarget }).strict(),
    handler: (params) => addRegisteredSshTarget(params.target)
  }),
  defineMethod({
    name: 'ssh.importConfig',
    params: z.object({ reAdopt: z.boolean().optional() }).strict().optional(),
    handler: (params) => importRegisteredSshConfig(params)
  }),
  defineMethod({
    name: 'ssh.browseDir',
    params: SshBrowse,
    handler: (params) =>
      browseSshDirectory(getSshConnectionManager(), params.targetId, params.dirPath)
  })
]
