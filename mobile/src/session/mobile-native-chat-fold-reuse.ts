import { useLayoutEffect, useMemo, useRef } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

// Treat id only as a candidate key; compare fields and ordered block identities before reuse.
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

// Reuse unchanged committed rows because folding copies runs across the window and would otherwise rerender every message.
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
