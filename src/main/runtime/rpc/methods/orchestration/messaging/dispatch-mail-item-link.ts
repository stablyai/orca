// `send --to dispatch:<id> --item <n>`: new work for a worker already running links it to the item, as
// `worker-start --item` does, so its report names the item. Checked before the send, written after it.
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { RpcContext } from '../../../core'
import { linkItem } from '../../bots-items-write-methods'

type ItemMail = { to?: string; item?: string; files?: string[] }

export function withDispatchItemLink<P extends ItemMail, R>(
  send: (params: P, ctx: RpcContext) => Promise<R>
): (params: P, ctx: RpcContext) => Promise<R> {
  return async (params, ctx) => {
    const { to, item } = params
    if (item === undefined || !to?.startsWith('dispatch:')) {
      return send(params, ctx)
    }
    if (params.files?.length) {
      throw new OrchestrationError(
        'invalid_argument',
        '--file goes with --to bot:<name> --item <n>. Nothing was sent.'
      )
    }
    const link = { item, refs: [to] }
    await linkItem({ ...link, check: true }, ctx)
    const sent = await send({ ...params, item: undefined }, ctx)
    await linkItem(link, ctx, { quiet: true })
    return sent
  }
}
