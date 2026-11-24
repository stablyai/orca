import { defineMethod } from '../../core'
import {
  PipelineV2TemplateListParams,
  PipelineV2TemplateShowParams,
  PipelineV2TemplateSaveParams,
  PipelineV2TemplateDeleteParams,
  PipelineV2TemplateValidateParams,
  PipelineV2TemplatePublishRequestParams,
  PipelineV2TemplateDisableRequestParams,
  PipelineV2RequestReceiptParams
} from '../../../../../shared/rpc-contract/pipeline-v2-params'
import { assertPipelineV2Project, pipelineV2DraftSource } from './pipeline-v2-template-source'
import { previewPipelineV2Launch } from '../../../pipelines/v2/pipeline-v2-launch-preview'
import {
  PipelineV2TemplateShowResult,
  PipelineV2TemplateSaveResult,
  PipelineV2TemplateDeleteResult,
  PipelineV2TemplateReceiptResult
} from '../../../../../shared/pipelines/v2/pipeline-v2-library-results'

export const PIPELINE_V2_TEMPLATE_METHODS = [
  defineMethod({
    name: 'pipeline.v2.template.delete',
    permission: 'workspace',
    params: PipelineV2TemplateDeleteParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      return PipelineV2TemplateDeleteResult.parse({
        contractVersion: 2 as const,
        receipt: await ctx.runtime.pipelineRuntime.store.templatesV2.deleteDraft(input)
      })
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.list',
    permission: 'workspace',
    params: PipelineV2TemplateListParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      return {
        contractVersion: 2 as const,
        ...(await ctx.runtime.pipelineRuntime.store.templatesV2.list(input))
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.show',
    permission: 'workspace',
    params: PipelineV2TemplateShowParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      if (input.selection && input.selection.projectId !== input.projectId) {
        throw new Error('pipeline_template_project_mismatch')
      }
      const library = ctx.runtime.pipelineRuntime.store.templatesV2
      const record = input.draftId
        ? await library.getDraft(input.projectId, input.draftId)
        : await library.getVersion(input.selection!)
      const template = 'draft' in record ? record.draft : record.definition
      if (input.cursor > template.stages.length) {
        throw new Error('pipeline_cursor_invalid')
      }
      const stage = input.stageId
        ? template.stages.find((value) => value.id === input.stageId)
        : undefined
      if (input.stageId && !stage) {
        throw new Error('pipeline_invalid_stage')
      }
      const launchPreview =
        input.full || stage
          ? await previewPipelineV2Launch(
              ctx.runtime,
              ctx.runtime.requireStore().getRepo(input.projectId)!,
              stage ? [stage] : template.stages
            )
          : undefined
      return PipelineV2TemplateShowResult.parse({
        contractVersion: 2 as const,
        projectId: input.projectId,
        id: template.id,
        title: template.title,
        description: template.description,
        provenance: record.provenance,
        ...('revision' in record
          ? { draftId: record.draftId, revision: record.revision }
          : { selection: input.selection, enabled: record.enabled }),
        stageCount: template.stages.length,
        stages: template.stages
          .slice(input.cursor, input.cursor + input.limit)
          .map((value) => ({ id: value.id, title: value.title, kind: value.kind })),
        cursor: Math.min(template.stages.length, input.cursor + input.limit),
        hasMore: input.cursor + input.limit < template.stages.length,
        ...(stage ? { stage } : {}),
        ...(input.full ? { record } : {}),
        ...(launchPreview ? { launchPreview } : {})
      })
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.save',
    permission: 'workspace',
    params: PipelineV2TemplateSaveParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const library = ctx.runtime.pipelineRuntime.store.templatesV2
      const replay = await library.replaySave(input)
      if (replay) {
        return PipelineV2TemplateSaveResult.parse({ contractVersion: 2 as const, receipt: replay })
      }
      const prepared = 'source' in input ? await pipelineV2DraftSource(ctx, input) : undefined
      return PipelineV2TemplateSaveResult.parse({
        contractVersion: 2 as const,
        receipt: await library.saveEdited(input, prepared)
      })
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.validate',
    permission: 'workspace',
    params: PipelineV2TemplateValidateParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const definition = await ctx.runtime.pipelineRuntime.store.templatesV2.validate(
        input.projectId,
        input.draftId,
        input.expectedRevision
      )
      return {
        contractVersion: 2 as const,
        projectId: input.projectId,
        draftId: input.draftId,
        revision: input.expectedRevision,
        valid: true,
        previewDigest: definition.digest
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.publishRequest',
    permission: 'workspace',
    params: PipelineV2TemplatePublishRequestParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const store = ctx.runtime.pipelineRuntime.store
      if (!(await store.ownerRequestsV2.get(input.projectId, input.requestId))) {
        await store.templatesV2.validate(input.projectId, input.draftId, input.expectedRevision)
      }
      return {
        contractVersion: 2 as const,
        request: await store.ownerRequestsV2.request('publish', input)
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.disableRequest',
    permission: 'workspace',
    params: PipelineV2TemplateDisableRequestParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const store = ctx.runtime.pipelineRuntime.store
      await store.templatesV2.getVersion({
        engineVersion: 2,
        projectId: input.projectId,
        id: input.id,
        version: input.version,
        digest: input.digest
      })
      return {
        contractVersion: 2 as const,
        request: await store.ownerRequestsV2.request('disable', input)
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.template.receipt',
    permission: 'workspace',
    params: PipelineV2RequestReceiptParams,
    handler: async (input, ctx) => {
      assertPipelineV2Project(ctx, input.projectId, input.expectedRuntimeId)
      const store = ctx.runtime.pipelineRuntime.store
      return PipelineV2TemplateReceiptResult.parse({
        contractVersion: 2 as const,
        projectId: input.projectId,
        request: await store.ownerRequestsV2.get(input.projectId, input.requestId),
        receipt: await store.templatesV2.receipt(input.projectId, input.requestId)
      })
    }
  })
]
