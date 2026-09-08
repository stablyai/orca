import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runKeyedSerializedOperation } from '../../../cli/keyed-promise-queue'
import {
  MOBILE_WEB_FILE_EDIT_MAX_BYTES,
  MobileWebFileWritePayloadSchema
} from '../../../../shared/mobile-web/file-edit-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'

const MobileFileWriteIfUnchangedParamsSchema = MobileWebFileWritePayloadSchema.omit({
  workspaceId: true
})
  .extend({
    worktree: z.string().min(1),
    expectedExecutionHostId: z.union([z.literal('local'), z.string().regex(/^ssh:.+/)]),
    expectedSshTargetId: z.string().min(1).optional(),
    expectedSshConnectionGeneration: z.number().int().nonnegative().optional()
  })
  .strict()

type MobileFileWriteIfUnchangedParams = z.infer<typeof MobileFileWriteIfUnchangedParamsSchema>
const writeQueues = new WeakMap<OrcaRuntimeService, Map<string, Promise<void>>>()

export const MOBILE_FILE_WRITE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'files.writeIfUnchanged',
    params: MobileFileWriteIfUnchangedParamsSchema,
    handler: async (params, { runtime }) => {
      let queues = writeQueues.get(runtime)
      if (!queues) {
        queues = new Map()
        writeQueues.set(runtime, queues)
      }
      // Host-wide ordering covers aliases for the same file without trusting a client path key.
      return runKeyedSerializedOperation(queues, params.expectedExecutionHostId, () =>
        writeMobileFileIfUnchanged(runtime, params)
      )
    }
  })
]

async function writeMobileFileIfUnchanged(
  runtime: OrcaRuntimeService,
  params: MobileFileWriteIfUnchangedParams
): Promise<
  { ok: true; revision: string; byteLength: number } | { ok: false; code: 'conflict' | 'too_large' }
> {
  const current = await runtime.readFileExplorerChunk(
    params.worktree,
    params.relativePath,
    0,
    MOBILE_WEB_FILE_EDIT_MAX_BYTES
  )
  if (!current.eof) {
    return { ok: false, code: 'too_large' }
  }
  const currentBytes = decodeChunk(current.contentBase64, current.bytesRead)
  if (sha256Hex(currentBytes) !== params.expectedRevision) {
    return { ok: false, code: 'conflict' }
  }

  const nextBytes = Buffer.from(params.contentBase64, 'base64')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(nextBytes)
  } catch {
    throw new InvalidArgumentError('File content must be valid UTF-8')
  }
  await runtime.writeFileExplorerFile(
    params.worktree,
    params.relativePath,
    content,
    params.expectedSshConnectionGeneration,
    params.expectedSshTargetId,
    params.expectedExecutionHostId
  )
  return { ok: true, revision: sha256Hex(nextBytes), byteLength: nextBytes.byteLength }
}

function decodeChunk(contentBase64: string, expectedByteLength: number): Buffer {
  const bytes = Buffer.from(contentBase64, 'base64')
  if (
    bytes.byteLength !== expectedByteLength ||
    bytes.byteLength > MOBILE_WEB_FILE_EDIT_MAX_BYTES
  ) {
    throw new Error('mobile file preflight returned invalid content')
  }
  return bytes
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
