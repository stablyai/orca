import { defineMethod, type RpcAnyMethod } from '../core'
import { KaneoConnectSchema, KaneoTaskUrlSchema } from '../../../../shared/kaneo-schemas'

export const KANEO_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'kaneo.status',
    params: null,
    handler: (_args, { runtime }) => runtime.kaneoStatus()
  }),
  defineMethod({
    name: 'kaneo.connect',
    params: KaneoConnectSchema,
    handler: (args, { runtime }) => runtime.kaneoConnect(args)
  }),
  defineMethod({
    name: 'kaneo.disconnect',
    params: null,
    handler: (_args, { runtime }) => runtime.kaneoDisconnect()
  }),
  defineMethod({
    name: 'kaneo.getTask',
    params: KaneoTaskUrlSchema,
    handler: (args, { runtime, signal }) => runtime.kaneoGetTask(args.url, signal)
  })
]
