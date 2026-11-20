import { GetPipelineConfig } from '../../../../shared/rpc-contract/github/github-pipeline-params'
import { loadPipelineConfig } from '../../../github/pipeline/pipeline-config-loader'
import { ensurePipelineConfigWatch } from '../../../github/pipeline/pipeline-config-watcher'
import { defineMethod } from '../core'

export const PIPELINE_CONFIG_METHODS = [
  defineMethod({
    name: 'pipeline.config.get',
    permission: 'workspace',
    params: GetPipelineConfig,
    handler: async (params) => {
      ensurePipelineConfigWatch()
      return loadPipelineConfig(params.workspaceRoot)
    }
  })
]
