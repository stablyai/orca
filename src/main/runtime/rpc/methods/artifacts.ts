import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'

const CloudOptions = {
  apiUrl: z.string().optional(),
  authToken: z.string().optional()
}

const ListOptions = z.object({
  ...CloudOptions,
  cursor: z.string().min(1).max(2_048).optional()
})

const WriteRequest = z.object({
  sourceKey: z.string().min(1),
  content: z.string().min(1),
  contentType: z.enum(['text/html', 'text/markdown']),
  fileName: z.string().min(1),
  title: z.string().optional(),
  ...CloudOptions
})

export const ARTIFACT_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'artifacts.list',
    params: ListOptions,
    handler: (params, { runtime }) => runtime.listArtifacts(params)
  }),
  defineMethod({
    name: 'artifacts.share',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.shareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.update',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.updateArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.unshare',
    params: z.object({ sourceKey: z.string().min(1), ...CloudOptions }),
    handler: (params, { runtime }) => runtime.unshareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.delete',
    params: z.object({ id: z.string().min(1), ...CloudOptions }),
    handler: (params, { runtime }) => runtime.deleteArtifact(params.id, params)
  })
]
