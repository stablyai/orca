import { defineStreamingMethod } from '../../core'
import { PrepareAgentImages } from '../../../../../shared/rpc-contract/filesystem/files-params'

export const FILE_AGENT_IMAGE_METHODS = [
  defineStreamingMethod({
    name: 'files.prepareAgentImages',
    permission: 'workspace',
    params: PrepareAgentImages,
    handler: async (params, { runtime, signal }, emit) => {
      emit({ paths: await runtime.prepareAgentImages(params.paths, signal, params.wslDistro) })
    }
  })
]
