import { defineMethod } from '../../core'
import { TextGenerate } from '../../../../../shared/rpc-contract/text-params'

export const TEXT_METHODS = [
  defineMethod({
    name: 'text.generate',
    permission: 'workspace',
    params: TextGenerate,
    handler: (params, context) => context.runtime.textGenerate(params, context.signal)
  })
]
