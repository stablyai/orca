import { defineMethod } from '../core'
import {
  RANGED_FILE_DOCUMENT_METHODS,
  RangedFileDocumentError,
  RangedDocumentCancel,
  RangedDocumentId,
  RangedDocumentOpen,
  RangedDocumentRead
} from '../../../../shared/ranged-file-document'

function owner(connectionId: string | undefined): string {
  if (!connectionId) {
    throw new RangedFileDocumentError(
      'range_document_unsupported',
      'Ranged documents require a stable runtime connection.'
    )
  }
  return connectionId
}

export const FILE_RANGED_DOCUMENT_METHODS = [
  defineMethod({
    name: RANGED_FILE_DOCUMENT_METHODS.open,
    permission: 'workspace',
    params: RangedDocumentOpen,
    handler: async (params, { runtime, connectionId, signal }) =>
      runtime.rangedFileDocuments.openTarget(owner(connectionId), params, signal)
  }),
  defineMethod({
    name: RANGED_FILE_DOCUMENT_METHODS.read,
    permission: 'workspace',
    params: RangedDocumentRead,
    handler: async (params, { runtime, connectionId, signal }) =>
      runtime.rangedFileDocuments.read(owner(connectionId), params, signal)
  }),
  defineMethod({
    name: RANGED_FILE_DOCUMENT_METHODS.reload,
    permission: 'workspace',
    params: RangedDocumentId,
    handler: async (params, { runtime, connectionId, signal }) =>
      runtime.rangedFileDocuments.reload(owner(connectionId), params.id, signal)
  }),
  defineMethod({
    name: RANGED_FILE_DOCUMENT_METHODS.status,
    permission: 'workspace',
    params: RangedDocumentId,
    handler: async (params, { runtime, connectionId }) =>
      runtime.rangedFileDocuments.status(owner(connectionId), params.id)
  }),
  defineMethod({
    name: RANGED_FILE_DOCUMENT_METHODS.close,
    permission: 'workspace',
    params: RangedDocumentId,
    handler: async (params, { runtime, connectionId }) => {
      await runtime.rangedFileDocuments.close(owner(connectionId), params.id)
      return { ok: true }
    }
  }),
  defineMethod({
    name: RANGED_FILE_DOCUMENT_METHODS.cancel,
    permission: 'workspace',
    params: RangedDocumentCancel,
    handler: async (params, { runtime, connectionId }) => {
      runtime.rangedFileDocuments.cancel(owner(connectionId), params.id, params.requestToken)
      return { ok: true }
    }
  })
]
