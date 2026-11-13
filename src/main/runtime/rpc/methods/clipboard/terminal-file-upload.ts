import type { z } from 'zod'
import { defineMethod, type RpcContext } from '../../core'
import { getAppEnvironment } from '../../../../../shared/app-environment'
import {
  TerminalFileUploadAppendParams,
  TerminalFileUploadIdParams,
  TerminalFileUploadStartParams
} from '../../../../../shared/rpc-contract/terminal-file-upload-params'
import { SshHostNotServedError } from '../../../../providers/ssh-host-not-served-error'
import { TerminalFileUploadStore } from '../../../../terminal-file-upload/terminal-file-upload-store'

type TerminalFileUploadCaller = Pick<RpcContext, 'clientKind' | 'clientId'>

// Uploads belong to the phone that started them; every desktop caller shares one key.
function callerKey(ctx: TerminalFileUploadCaller): string {
  if (ctx.clientKind !== 'mobile') {
    return 'desktop'
  }
  const clientId = ctx.clientId?.trim()
  if (!clientId) {
    throw new Error('Terminal file upload requires an authenticated mobile client')
  }
  return clientId
}

/** What the RPC layer adds to the store: the SSH refusal and keeping each caller's uploads its own. */
export function terminalFileUploadHandlers(store: TerminalFileUploadStore) {
  return {
    start: async (
      params: z.infer<typeof TerminalFileUploadStartParams>,
      ctx: TerminalFileUploadCaller
    ) => {
      if (params.connectionId) {
        throw new SshHostNotServedError(params.connectionId)
      }
      return store.start({
        callerKey: callerKey(ctx),
        name: params.name,
        byteLength: params.byteLength
      })
    },
    append: (
      params: z.infer<typeof TerminalFileUploadAppendParams>,
      ctx: TerminalFileUploadCaller
    ) => store.append({ callerKey: callerKey(ctx), ...params }),
    commit: (params: z.infer<typeof TerminalFileUploadIdParams>, ctx: TerminalFileUploadCaller) =>
      store.commit({ callerKey: callerKey(ctx), uploadId: params.uploadId }),
    abort: (params: z.infer<typeof TerminalFileUploadIdParams>, ctx: TerminalFileUploadCaller) =>
      store.abort({ callerKey: callerKey(ctx), uploadId: params.uploadId })
  }
}

const handlers = terminalFileUploadHandlers(
  new TerminalFileUploadStore(() => getAppEnvironment().getPath('temp'))
)

export const TERMINAL_FILE_UPLOAD_METHODS = [
  defineMethod({
    name: 'terminalFileUpload.start',
    permission: 'workspace',
    params: TerminalFileUploadStartParams,
    handler: handlers.start
  }),
  defineMethod({
    name: 'terminalFileUpload.append',
    permission: 'workspace',
    params: TerminalFileUploadAppendParams,
    handler: handlers.append
  }),
  defineMethod({
    name: 'terminalFileUpload.commit',
    permission: 'workspace',
    params: TerminalFileUploadIdParams,
    handler: handlers.commit
  }),
  defineMethod({
    name: 'terminalFileUpload.abort',
    permission: 'workspace',
    params: TerminalFileUploadIdParams,
    handler: handlers.abort
  })
]
