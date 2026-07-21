import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const OpenTerminalAtPath = z.object({
  path: requiredString('Missing folder path'),
  title: OptionalString
})

const OpenWorkspaceAtPath = z.object({
  path: requiredString('Missing folder path'),
  name: OptionalString,
  terminal: z.unknown().optional()
})

export const FINDER_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'finder.openTerminalAtPath',
    params: OpenTerminalAtPath,
    handler: async (params, { runtime }) =>
      runtime.openFinderTerminalAtPath({
        path: params.path,
        ...(params.title ? { title: params.title } : {})
      })
  }),
  defineMethod({
    name: 'finder.openWorkspaceAtPath',
    params: OpenWorkspaceAtPath,
    handler: async (params, { runtime }) =>
      runtime.openFinderWorkspaceAtPath({
        path: params.path,
        ...(params.name ? { name: params.name } : {}),
        terminal: params.terminal === true
      })
  })
]
