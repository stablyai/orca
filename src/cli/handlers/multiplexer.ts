import type { CommandHandler } from '../dispatch'
import type { WorkspaceMultiplexerState } from '../../shared/workspace-multiplexer-types'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'

export const MULTIPLEXER_HANDLERS: Record<string, CommandHandler> = {
  'multiplexer list': async ({ client, json }) => {
    const result = await client.call<{ multiplexer: WorkspaceMultiplexerState }>('multiplexer.list')
    printResult(
      result,
      json,
      ({ multiplexer }) =>
        multiplexer.slots
          .map((slot) => `${slot.id}\t${slot.executionHostId ?? 'local'}\t${slot.worktreeId}`)
          .join('\n') || 'No workspace tabs in the active multiplexer.'
    )
  },
  'multiplexer remove': async ({ client, flags, json }) => {
    const result = await client.call<{ slotId: string; removed: boolean }>('multiplexer.remove', {
      slotId: getRequiredStringFlag(flags, 'slot')
    })
    printResult(
      result,
      json,
      ({ slotId, removed }) =>
        `${slotId}: ${removed ? 'removed from multiplexer' : 'already absent'}`
    )
  }
}
