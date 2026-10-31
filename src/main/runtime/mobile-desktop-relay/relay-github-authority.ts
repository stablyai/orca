import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { classifyExactGitHubOperation } from '../../../shared/github/exact-work-item-operation'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-item-target'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../shared/source-control-runtime-capabilities'
import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type { RelayedPhoneReplies } from './relayed-phone-frames'

const exactGitHubStatus = z.looseObject({
  ok: z.literal(true),
  result: z.looseObject({
    runtimeId: z.string().optional(),
    hostDescriptor: z.looseObject({ installationId: z.string() }).optional(),
    capabilities: z.array(z.string()).optional()
  })
})

export function verifyRelayedGitHubAuthority(args: {
  method: string
  frame: string
  socket: RemoteRuntimePassthroughSocket
  replies: RelayedPhoneReplies
  isCurrent: () => boolean
  timeoutMs: number
}): Promise<void> | undefined {
  const parsed: unknown = JSON.parse(args.frame)
  const bound = classifyExactGitHubOperation(
    args.method,
    typeof parsed === 'object' && parsed !== null && 'params' in parsed ? parsed.params : undefined,
    parsed
  )
  if (!bound) {
    return
  }
  const id = `relay-github-authority:${randomUUID()}`
  return args.replies
    .request(
      id,
      () => args.socket.send(JSON.stringify({ id, method: 'status.get' })),
      args.timeoutMs
    )
    .then((reply) => {
      if (!args.isCurrent()) {
        return
      }
      const status = exactGitHubStatus.safeParse(reply)
      if (!status.success) {
        throw new Error('Unable to confirm the executing Orca server. Try again.')
      }
      if (
        !status.data.result.capabilities?.includes(GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY)
      ) {
        throw new Error(GITHUB_EXACT_OPERATION_UNSUPPORTED)
      }
      if (
        status.data.result.runtimeId !== bound.expectedRuntimeSource.runtimeId ||
        status.data.result.hostDescriptor?.installationId !== bound.expectedRuntimeSource.sourceId
      ) {
        throw new Error('The executing Orca server changed. Try again.')
      }
    })
}
