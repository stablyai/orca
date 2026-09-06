import { z } from 'zod'
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_REQUEST_BYTES,
  artifactContentByteLength,
  artifactWriteRequestByteLength
} from '../../../../shared/artifacts'
import { defineMethod, type RpcAnyMethod } from '../core'

const CloudOptions = {
  apiUrl: z.string().max(2_048).optional(),
  authToken: z.string().max(16_384).optional()
}

const ListOptions = z.object({
  ...CloudOptions,
  cursor: z.string().min(1).max(2_048).optional()
})

const SourceRequest = z.object({
  sourceKey: z.string().min(1).max(32_768),
  ...CloudOptions
})

const WriteRequest = z
  .object({
    sourceKey: z.string().min(1).max(32_768),
    content: z
      .string()
      .min(1)
      .max(ARTIFACT_MAX_CONTENT_BYTES)
      .refine((content) => artifactContentByteLength(content) <= ARTIFACT_MAX_CONTENT_BYTES, {
        message: 'Artifact content exceeds the 10 MiB limit.'
      }),
    contentType: z.enum(['text/html', 'text/markdown']),
    fileName: z.string().min(1).max(512),
    title: z.string().max(512).optional(),
    ...CloudOptions
  })
  .refine((request) => artifactWriteRequestByteLength(request) <= ARTIFACT_MAX_REQUEST_BYTES, {
    message: 'Artifact request exceeds the supported size.'
  })

export const ARTIFACT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'artifacts.list',
    params: ListOptions,
    handler: (params, { runtime }) => runtime.listArtifacts(params)
  }),
  defineMethod({
    name: 'artifacts.getPublishedLink',
    params: SourceRequest,
    handler: (params, { runtime }) => runtime.getPublishedArtifactLink(params)
  }),
  defineMethod({
    name: 'artifacts.share',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.shareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.publish',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.publishArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.update',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.updateArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.unshare',
    params: SourceRequest,
    handler: (params, { runtime }) => runtime.unshareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.delete',
    params: z.object({ id: z.string().min(1), ...CloudOptions }),
    handler: (params, { runtime }) => runtime.deleteArtifact(params.id, params)
  })
]
