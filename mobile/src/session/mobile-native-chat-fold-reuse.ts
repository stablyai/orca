import { useLayoutEffect, useMemo, useRef } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** The fold rebuilt this row with nothing in it changed: the same fields and the same block objects
 *  in the same order. Its id only names the candidate; content decides. */
function unchanged(previous: NativeChatMessage, next: NativeChatMessage): boolean {
  if (
    previous.blocks.length !== next.blocks.length ||
    previous.blocks.some((block, at) => block !== next.blocks[at])
  ) {
    return false
  }
  const fields = new Map(Object.entries(previous))
  const nextFields = Object.entries(next)
  return (
    fields.size === nextFields.length &&
    nextFields.every(([name, value]) => name === 'blocks' || fields.get(name) === value)
  )
}

/** The folded rows, keeping each unchanged row's last committed object: a raw message re-folds the
 *  whole window, which copies every tool run, so rows that drew nothing new would draw again. Only
 *  the last committed rows of the chat shown are kept. */
export function useMobileNativeChatFoldReuse(
  folded: NativeChatMessage[],
  scope: string
): NativeChatMessage[] {
  const committed = useRef<{ scope: string; byId: Map<string, NativeChatMessage> } | null>(null)
  const rows = useMemo(() => {
    const byId = committed.current?.scope === scope ? committed.current.byId : null
    let kept = 0
    const out = folded.map((row) => {
      const previous = byId?.get(row.id)
      if (previous && previous !== row && unchanged(previous, row)) {
        kept += 1
        return previous
      }
      return row
    })
    return kept > 0 ? out : folded
  }, [folded, scope])
  useLayoutEffect(() => {
    committed.current = { scope, byId: new Map(rows.map((row) => [row.id, row])) }
  }, [rows, scope])
  return rows
}
