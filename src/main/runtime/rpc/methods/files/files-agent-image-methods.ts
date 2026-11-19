import { defineMethod } from '../../core'
import { PrepareAgentImages } from '../../../../../shared/rpc-contract/filesystem/files-params'

export const FILE_AGENT_IMAGE_METHODS = [
  defineMethod({
    name: 'files.prepareAgentImages',
    permission: 'workspace',
    params: PrepareAgentImages,
    handler: async (params, { runtime, signal }) => ({
      paths: await runtime.prepareAgentImages(params.paths, signal)
    })
  })
]
