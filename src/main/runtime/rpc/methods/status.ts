import { defineMethod, type RpcMethod } from '../core'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime }) => runtime.getStatus()
  })
]
