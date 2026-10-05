import { z } from 'zod'
import {
  editorRecoveryChangeSchema,
  editorRecoveryMetadataSchema
} from '../../shared/editor-recovery'

export const editorRecoveryRequestSchema = z.object({
  requestId: z.number().int().positive(),
  command: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list') }),
    z.object({ kind: z.literal('read'), id: z.string() }),
    z.object({ kind: z.literal('status'), ids: z.array(z.string()) }),
    z.object({ kind: z.literal('apply'), changes: z.array(editorRecoveryChangeSchema) }),
    z.object({
      kind: z.literal('import'),
      drafts: z.array(z.object({ metadata: editorRecoveryMetadataSchema, content: z.string() }))
    }),
    z.object({
      kind: z.literal('restore'),
      resources: z.array(editorRecoveryMetadataSchema),
      checkpointIds: z.array(z.string())
    }),
    z.object({
      kind: z.literal('export'),
      id: z.string(),
      revision: z.number().int().positive(),
      targetPath: z.string()
    }),
    z.object({ kind: z.literal('close') })
  ])
})
export type EditorRecoveryCommand = z.infer<typeof editorRecoveryRequestSchema>['command']
export const editorRecoveryResponseSchema = z.discriminatedUnion('ok', [
  z.object({ requestId: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }),
  z.object({ requestId: z.number().int().positive(), ok: z.literal(false), error: z.string() })
])
