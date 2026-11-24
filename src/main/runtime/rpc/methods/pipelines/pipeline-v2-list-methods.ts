import { defineMethod } from '../../core'
import { PipelineV2ListParams } from '../../../../../shared/rpc-contract/pipeline-v2-params'
import { pipelineV2Summary } from './pipeline-v2-scope'
import { assertPipelineV2Project } from './pipeline-v2-template-source'

export const PIPELINE_V2_LIST_METHODS = [
  defineMethod({
    name: 'pipeline.v2.profiles',
    permission: 'workspace',
    params: PipelineV2ListParams,
    handler: (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const page = ctx.runtime.pipelineRuntime.store.templatesV2.list(
        { ...input, kind: 'versions', enabledOnly: true },
        true
      )
      return {
        contractVersion: 2 as const,
        projectId: input.projectId,
        profiles: page.templates.flatMap((row) =>
          row.kind === 'versions'
            ? [{ ...row.selection, title: row.title, stageCount: row.stageCount }]
            : []
        ),
        cursor: page.cursor,
        hasMore: page.hasMore
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.list',
    permission: 'workspace',
    params: PipelineV2ListParams,
    handler: (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const all = ctx.runtime.pipelineRuntime.store.pageV2(
        input.projectId,
        input.cursor,
        input.limit
      )
      const runs: ReturnType<typeof pipelineV2Summary>[] = []
      let cursor = input.cursor
      for (const row of all.slice(0, input.limit)) {
        const summary = pipelineV2Summary(row.run)
        if (Buffer.byteLength(JSON.stringify({ runs: [...runs, summary] })) > 47000) {
          break
        }
        runs.push(summary)
        cursor = row.cursor
      }
      return {
        contractVersion: 2 as const,
        projectId: input.projectId,
        runs,
        cursor,
        hasMore: all.length > runs.length
      }
    }
  })
]
