import { defineMethod } from '../core'
import {
  ArtifactsDeleteParams,
  ListOptions,
  SourceRequest,
  WriteRequest
} from '../../../../shared/rpc-contract/artifacts-params'

export const ARTIFACT_METHODS = [
  defineMethod({
    name: 'artifacts.list',
    permission: 'workspace',
    params: ListOptions,
    handler: (params, { runtime }) => runtime.listArtifacts(params)
  }),
  defineMethod({
    name: 'artifacts.getPublishedLink',
    permission: 'workspace',
    params: SourceRequest,
    handler: (params, { runtime }) => runtime.getPublishedArtifactLink(params)
  }),
  defineMethod({
    name: 'artifacts.share',
    permission: 'workspace',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.shareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.publish',
    permission: 'workspace',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.publishArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.update',
    permission: 'workspace',
    params: WriteRequest,
    handler: (params, { runtime }) => runtime.updateArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.unshare',
    permission: 'workspace',
    params: SourceRequest,
    handler: (params, { runtime }) => runtime.unshareArtifact(params)
  }),
  defineMethod({
    name: 'artifacts.delete',
    permission: 'workspace',
    params: ArtifactsDeleteParams,
    handler: (params, { runtime }) => runtime.deleteArtifact(params.id, params)
  })
]
