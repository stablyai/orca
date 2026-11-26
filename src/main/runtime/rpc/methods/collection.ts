import { defineMethod } from '../core'
import {
  CollectionCreate,
  CollectionSelector,
  CollectionUpdate
} from '../../../../shared/rpc-contract/collection-params'

export const COLLECTION_METHODS = [
  defineMethod({
    name: 'collection.list',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => ({ collections: runtime.listCollections() })
  }),
  defineMethod({
    name: 'collection.create',
    permission: 'workspace',
    params: CollectionCreate,
    handler: async (params, { runtime }) => ({
      collection: await runtime.createCollection(params)
    })
  }),
  defineMethod({
    name: 'collection.update',
    permission: 'workspace',
    params: CollectionUpdate,
    handler: async (params, { runtime }) => ({
      collection: await runtime.updateCollection(params.collectionId, params.updates)
    })
  }),
  defineMethod({
    name: 'collection.delete',
    permission: 'workspace',
    params: CollectionSelector,
    handler: async (params, { runtime }) => runtime.deleteCollection(params.collectionId)
  })
]
