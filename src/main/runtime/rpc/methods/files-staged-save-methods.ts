import { defineMethod } from '../core'
import {
  FileSaveAbort,
  FileSaveBegin,
  FileSaveChunk,
  FileSaveCommit
} from '../../../../shared/rpc-contract/files-staged-save-params'
import { STAGED_FILE_SAVE_METHODS } from '../../../../shared/staged-file-save'

// Saves belong to the socket that began them; in-process callers share one owner.
const owner = (connectionId: string | undefined) => connectionId ?? 'in-process'

export const FILE_STAGED_SAVE_METHODS = [
  defineMethod({
    name: STAGED_FILE_SAVE_METHODS.begin,
    permission: 'workspace',
    params: FileSaveBegin,
    handler: async (params, { runtime, connectionId }) =>
      runtime.stagedFileSaves.begin(owner(connectionId), params)
  }),
  defineMethod({
    name: STAGED_FILE_SAVE_METHODS.chunk,
    permission: 'workspace',
    params: FileSaveChunk,
    handler: async (params, { runtime, connectionId }) => {
      await runtime.stagedFileSaves.append(
        owner(connectionId),
        params.saveId,
        params.offset,
        Buffer.from(params.contentBase64, 'base64')
      )
      return { ok: true }
    }
  }),
  defineMethod({
    name: STAGED_FILE_SAVE_METHODS.commit,
    permission: 'workspace',
    params: FileSaveCommit,
    handler: async (params, { runtime, connectionId }) =>
      runtime.stagedFileSaves.commit(owner(connectionId), params.saveId, params.diskPrecondition)
  }),
  defineMethod({
    name: STAGED_FILE_SAVE_METHODS.abort,
    permission: 'workspace',
    params: FileSaveAbort,
    handler: async (params, { runtime, connectionId }) => {
      await runtime.stagedFileSaves.abort(owner(connectionId), params.saveId)
      return { ok: true }
    }
  })
]
