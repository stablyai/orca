import { defineMethod } from '../core'
import { ReferenceFind, ReferenceList } from '../../../../shared/rpc-contract/reference-params'

export const REFERENCE_METHODS = [
  defineMethod({
    name: 'reference.list',
    permission: 'workspace',
    params: ReferenceList,
    handler: (params, { runtime }) => runtime.listWorkspaceReferences(params.worktree, params.cwd)
  }),
  defineMethod({
    name: 'reference.find',
    permission: 'workspace',
    params: ReferenceFind,
    handler: (params, { runtime }) => runtime.findWorkspaceReferences(params)
  })
]
