import { z } from 'zod'
import { connectRegisteredSshTarget, getRegisteredSshState } from '../../../ipc/ssh'
import { defineMethod, type RpcMethod } from '../core'

const SshTarget = z.object({
  targetId: z.string().min(1)
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
  })
]
