import { z } from 'zod'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { MobileWebFileWritePayloadSchema } from '../../../../shared/mobile-web/file-edit-contract'
import { getSshConnectionGeneration } from '../../../ssh/ssh-connection-generation'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'
import { MOBILE_FILE_WRITE_METHODS } from './mobile-file-write-if-unchanged'

const write = MOBILE_FILE_WRITE_METHODS.find((method) => method.name === 'files.writeIfUnchanged')
if (!write || isStreamingMethod(write)) {
  throw new Error('Missing mobile file writer')
}
const writer = write

const WriteResult = z.union([
  z.object({ ok: z.literal(true), revision: z.string(), byteLength: z.number() }),
  z.object({ ok: z.literal(false), code: z.enum(['conflict', 'too_large']) })
])

export const MOBILE_WEB_FILE_WRITE_METHOD = defineMethod({
  name: 'mobileWeb.files.write',
  params: MobileWebFileWritePayloadSchema.omit({ workspaceId: true }).extend({
    worktree: z.string().min(1).max(4096)
  }),
  handler: async (params, context) => {
    const result = WriteResult.parse(
      await writer.handler(
        writer.params!.parse({
          worktree: params.worktree,
          relativePath: params.relativePath,
          expectedRevision: params.expectedRevision,
          contentBase64: params.contentBase64,
          ...(await executionHostExpectation(params.worktree, context))
        }),
        context
      )
    )
    // Conflict and size are outcomes the page acts on; an RPC error would reach it as `host_error`.
    return result.ok
      ? {
          relativePath: params.relativePath,
          revision: result.revision,
          byteLength: result.byteLength,
          outcome: 'updated'
        }
      : { outcome: result.code }
  }
})

/** The worktree's host as it stands now, so a rehome during this handler's own awaits is refused. */
async function executionHostExpectation(
  worktree: string,
  context: RpcContext
): Promise<Record<string, unknown>> {
  const resolved = await context.runtime.showManagedWorktree(worktree)
  const host = parseExecutionHostId((resolved as { hostId?: string | null }).hostId)
  if (host?.kind !== 'ssh') {
    return { expectedExecutionHostId: 'local' }
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: getSshConnectionGeneration(host.targetId)
  }
}
