import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const CollectionCreate = z.object({
  name: requiredString('Missing collection name'),
  color: z.string().nullable().optional()
})

const CollectionUpdate = z.object({
  collectionId: requiredString('Missing collection id'),
  updates: z.object({
    name: OptionalString,
    color: z.string().nullable().optional(),
    isCollapsed: z.boolean().optional(),
    order: OptionalFiniteNumber
  })
})

const CollectionSelector = z.object({
  collectionId: requiredString('Missing collection id')
})

export const COLLECTION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'collection.list',
    params: null,
    handler: (_params, { runtime }) => ({ collections: runtime.listCollections() })
  }),
  defineMethod({
    name: 'collection.create',
    params: CollectionCreate,
    handler: async (params, { runtime }) => ({
      collection: await runtime.createCollection(params)
    })
  }),
  defineMethod({
    name: 'collection.update',
    params: CollectionUpdate,
    handler: async (params, { runtime }) => ({
      collection: await runtime.updateCollection(params.collectionId, params.updates)
    })
  }),
  defineMethod({
    name: 'collection.delete',
    params: CollectionSelector,
    handler: async (params, { runtime }) => runtime.deleteCollection(params.collectionId)
  })
]
