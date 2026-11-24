import type Database from '../../../sqlite/sync-database'
import type { z } from 'zod'
import { requirePipelineV2ProjectChecks } from './pipeline-v2-template-checks'
import { PipelineV2Template } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { compilePipelineV2 } from '../../../../shared/pipelines/v2/pipeline-v2-compiler'
import { writePipelineV2Draft } from './pipeline-v2-draft-write'
import {
  PipelineV2TemplateSaveParams,
  PipelineV2TemplateDeleteParams
} from '../../../../shared/rpc-contract/pipeline-v2-params'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { editPipelineV2Draft } from './pipeline-v2-draft-edits'
import {
  listPipelineV2Templates,
  replayPipelineV2Template,
  readPipelineV2TemplateReceipt
} from './pipeline-v2-template-queries'
import {
  PipelineV2Draft,
  PipelineV2DraftDeleteReceipt,
  type PipelineV2DraftReceipt,
  PipelineV2DraftSaveInput,
  PipelineV2TemplateCopyInput,
  PipelineV2TemplateDisableInput,
  type PipelineV2TemplateProvenance,
  PipelineV2TemplatePublishInput,
  PipelineV2TemplateReceipt,
  PipelineV2TemplateSelection,
  PipelineV2Version
} from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import {
  initializePipelineV2Templates,
  pipelineV2TemplateRequest
} from './pipeline-v2-template-journal'

export class PipelineV2Templates {
  constructor(private readonly db: Database.Database) {
    initializePipelineV2Templates(db)
  }
  hasReceipt(requestId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT request_id FROM pipeline_template_requests_v2 WHERE request_id=?')
        .get(requestId)
    )
  }
  list(raw: unknown, latestOnly = false) {
    return listPipelineV2Templates(this.db, raw, latestOnly)
  }
  receipt(projectId: string, requestId: string) {
    return readPipelineV2TemplateReceipt(this.db, projectId, requestId)
  }
  replaySave(raw: unknown) {
    const input = PipelineV2TemplateSaveParams.parse(raw)
    return replayPipelineV2Template(this.db, input.requestId, { action: 'edit', ...input })
  }
  saveEdited(
    raw: unknown,
    prepared?: {
      draft: z.infer<typeof PipelineV2Template>
      provenance: z.infer<typeof PipelineV2TemplateProvenance>
    }
  ): PipelineV2DraftReceipt {
    const input = PipelineV2TemplateSaveParams.parse(raw)
    return pipelineV2TemplateRequest(this.db, input.requestId, { action: 'edit', ...input }, () => {
      const draft =
        'draft' in input
          ? input.draft
          : 'operations' in input
            ? editPipelineV2Draft(
                this.getDraft(input.projectId, input.draftId).draft,
                input.operations
              )
            : prepared?.draft
      if (!draft) {
        throw new Error('pipeline_draft_source_missing')
      }
      if ('source' in input && input.expectedRevision !== 0) {
        throw new Error('pipeline_derived_draft_requires_new_id')
      }
      return this.writeDraft(
        {
          requestId: input.requestId,
          projectId: input.projectId,
          expectedRevision: input.expectedRevision,
          draft
        },
        prepared?.provenance
      )
    })
  }
  validate(projectId: string, draftId: string, revision: number) {
    const draft = this.getDraft(projectId, draftId)
    if (draft.revision !== revision) {
      throw new Error('pipeline_revision_conflict')
    }
    const definition = compilePipelineV2(draft.draft)
    requirePipelineV2ProjectChecks(this.db, definition)
    return definition
  }
  deleteDraft(raw: unknown): PipelineV2DraftDeleteReceipt {
    const input = PipelineV2TemplateDeleteParams.parse(raw)
    return pipelineV2TemplateRequest(
      this.db,
      input.requestId,
      { action: 'delete', ...input },
      () => {
        const draft = this.getDraft(input.projectId, input.draftId)
        if (draft.revision !== input.expectedRevision) {
          throw new Error('pipeline_revision_conflict')
        }
        this.db
          .prepare(
            'INSERT INTO pipeline_template_deleted_drafts_v2 (project_id,id,revision) VALUES (?,?,?)'
          )
          .run(input.projectId, input.draftId, draft.revision)
        this.db
          .prepare('DELETE FROM pipeline_template_drafts_v2 WHERE project_id=? AND id=?')
          .run(input.projectId, input.draftId)
        return PipelineV2DraftDeleteReceipt.parse({
          action: 'deleted',
          requestId: input.requestId,
          projectId: input.projectId,
          draftId: input.draftId,
          revision: draft.revision,
          draftDigest: pipelineV2Fingerprint(draft.draft)
        })
      }
    )
  }
  getDraft(projectId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM pipeline_template_drafts_v2 WHERE project_id=? AND id=?')
      .get(projectId, id)
    if (!row) {
      throw new Error('pipeline_draft_not_found')
    }
    return PipelineV2Draft.parse({
      projectId,
      draftId: id,
      revision: row.revision,
      draft: JSON.parse(String(row.data)),
      provenance: JSON.parse(String(row.provenance)),
      updatedAt: row.updated_at
    })
  }
  saveDraft(raw: unknown): PipelineV2DraftReceipt {
    const input = PipelineV2DraftSaveInput.parse(raw)
    return pipelineV2TemplateRequest(this.db, input.requestId, { action: 'save', ...input }, () =>
      this.writeDraft(input)
    )
  }
  private writeDraft(
    input: z.infer<typeof PipelineV2DraftSaveInput>,
    provenance?: z.infer<typeof PipelineV2TemplateProvenance>
  ): PipelineV2DraftReceipt {
    return writePipelineV2Draft(this.db, input, provenance)
  }
  publish(raw: unknown): PipelineV2Version {
    const input = PipelineV2TemplatePublishInput.parse(raw)
    return pipelineV2TemplateRequest(
      this.db,
      input.requestId,
      { action: 'publish', ...input },
      () => {
        const draft = this.getDraft(input.projectId, input.draftId)
        if (draft.revision !== input.expectedRevision) {
          throw new Error('pipeline_revision_conflict')
        }
        const previous = this.db
          .prepare(
            'SELECT max(version) AS version FROM pipeline_template_versions_v2 WHERE project_id=? AND id=?'
          )
          .get(input.projectId, input.draftId)
        const definition = compilePipelineV2({
          ...draft.draft,
          version: String(Number(previous?.version ?? 0) + 1)
        })
        requirePipelineV2ProjectChecks(this.db, definition)
        const result = PipelineV2Version.parse({
          definition,
          enabled: true,
          provenance: draft.provenance,
          publishedAt: Date.now()
        })
        this.db
          .prepare(
            'INSERT INTO pipeline_template_versions_v2 (project_id,id,version,digest,enabled,definition,provenance,published_at) VALUES (?,?,?,?,?,?,?,?)'
          )
          .run(
            input.projectId,
            input.draftId,
            Number(definition.version),
            definition.digest,
            1,
            JSON.stringify(definition),
            JSON.stringify(result.provenance),
            result.publishedAt
          )
        return result
      }
    )
  }
  getVersion(raw: unknown): PipelineV2Version {
    const selection = PipelineV2TemplateSelection.parse(raw)
    const row = this.db
      .prepare(
        'SELECT definition,enabled,provenance,published_at FROM pipeline_template_versions_v2 WHERE project_id=? AND id=? AND version=? AND digest=?'
      )
      .get(selection.projectId, selection.id, selection.version, selection.digest)
    if (!row) {
      throw new Error('pipeline_template_unavailable_or_changed')
    }
    return PipelineV2Version.parse({
      definition: JSON.parse(String(row.definition)),
      enabled: row.enabled === 1,
      provenance: JSON.parse(String(row.provenance)),
      publishedAt: row.published_at
    })
  }
  resolve(raw: unknown): PipelineV2Version {
    const version = this.getVersion(raw)
    if (!version.enabled) {
      throw new Error('pipeline_template_disabled')
    }
    return version
  }
  setEnabled(raw: unknown) {
    const input = PipelineV2TemplateDisableInput.parse(raw)
    return pipelineV2TemplateRequest(
      this.db,
      input.requestId,
      { action: 'set-enabled', ...input },
      () => {
        this.getVersion({
          engineVersion: input.engineVersion,
          projectId: input.projectId,
          id: input.id,
          version: input.version,
          digest: input.digest
        })
        this.db
          .prepare(
            'UPDATE pipeline_template_versions_v2 SET enabled=? WHERE project_id=? AND id=? AND version=? AND digest=?'
          )
          .run(input.enabled ? 1 : 0, input.projectId, input.id, input.version, input.digest)
        const { requestId, enabled, ...selection } = input
        return PipelineV2TemplateReceipt.parse({
          requestId,
          selection,
          enabled,
          action: enabled ? 'enabled' : 'disabled'
        })
      }
    )
  }
  copyDraft(raw: unknown): PipelineV2DraftReceipt {
    const input = PipelineV2TemplateCopyInput.parse(raw)
    return pipelineV2TemplateRequest(this.db, input.requestId, { action: 'copy', ...input }, () => {
      const source = this.getVersion(input.source)
      const { engineVersion: _engine, digest: _digest, ...template } = source.definition
      const draft = PipelineV2Template.parse({
        ...template,
        projectId: input.projectId,
        id: input.id,
        version: '1'
      })
      return this.writeDraft(
        { requestId: input.requestId, projectId: input.projectId, expectedRevision: 0, draft },
        { kind: 'copy', source: input.source }
      )
    })
  }
}
