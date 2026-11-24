import { useRef, useState } from 'react'
import type { ConversationRow } from './project-conversations'

type DetailsOwner = { client: object | null; hostId: string | undefined; generation: number }

function sameDetailsOwner(left: DetailsOwner, right: DetailsOwner): boolean {
  return (
    left.client === right.client &&
    left.hostId === right.hostId &&
    left.generation === right.generation
  )
}

export function useConversationDetails(owner: DetailsOwner) {
  const current = useRef(owner)
  current.current = owner
  const [selection, setSelection] = useState<(DetailsOwner & { row: ConversationRow }) | null>(null)
  return {
    details: selection && sameDetailsOwner(selection, owner) ? selection.row : null,
    setDetails: (row: ConversationRow | null) => {
      if (sameDetailsOwner(current.current, owner)) {
        setSelection(row ? { ...owner, row } : null)
      }
    }
  }
}
