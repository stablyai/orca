import {
  GetPipelineConfig,
  RunPipelineCheckGate,
  RunPipelineCiWatch,
  RunPipelineMerge,
  RunPipelineReview
} from '../../../../shared/rpc-contract/github/github-pipeline-params'
import { loadPipelineConfig } from '../../../github/pipeline/pipeline-config-loader'
import { ensurePipelineConfigWatch } from '../../../github/pipeline/pipeline-config-watcher'
import {
  runPipelineCheckGate,
  runPipelineCiWatch,
  runPipelineMerge
} from '../../../github/pipeline/pipeline-stage-runners'
import { runOpenCodeReview } from '../../../github/review/open-code-review-runner'
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
  }),
  defineMethod({
    name: 'pipeline.gate.checkChanged',
    permission: 'workspace',
    params: RunPipelineCheckGate,
    handler: async (params) => runPipelineCheckGate(params)
  }),
  defineMethod({
    name: 'pipeline.review.run',
    permission: 'workspace',
    params: RunPipelineReview,
    handler: async (params) => runOpenCodeReview(params)
  }),
  defineMethod({
    name: 'pipeline.ci.watch',
    permission: 'workspace',
    params: RunPipelineCiWatch,
    handler: async (params) => runPipelineCiWatch(params)
  }),
  defineMethod({
    name: 'pipeline.pr.merge',
    permission: 'workspace',
    params: RunPipelineMerge,
    handler: async (params) => runPipelineMerge(params)
  })
]
