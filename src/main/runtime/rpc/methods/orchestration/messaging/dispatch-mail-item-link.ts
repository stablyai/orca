// `send --to dispatch:<id> --item <n>`: new work for a worker already running links it to the item, as
// `worker-start --item` does, so its report names the item and the places it links.
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { RpcContext } from '../../../core'
import { linkItem } from '../../bots-items-write-methods'

export async function linkDispatchMailItem<P extends { item?: string; files?: string[] }>(
  context: RpcContext,
  to: string,
  params: P
): Promise<P> {
  if (params.item === undefined || !to.startsWith('dispatch:')) {
    return params
  }
  if (params.files?.length) {
    throw new OrchestrationError(
      'invalid_argument',
      '--file goes with --to bot:<name> --item <n>. Nothing was sent.'
    )
  }
  await linkItem({ item: params.item, refs: [to] }, context)
  return { ...params, item: undefined }
}
