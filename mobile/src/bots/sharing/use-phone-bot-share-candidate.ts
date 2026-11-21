// What a Publish or Update link would send, built on the bot's computer from the picks on screen;
// the desktop's useBotShareCandidate.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { botShareErrorMessage } from './bot-share-copy'
import {
  botSharePrepare,
  type PhoneShareCandidate,
  type PhoneShareSelection
} from './bot-share-operations'

export type PhoneShareCandidateState = {
  candidate: PhoneShareCandidate | null
  selection: PhoneShareSelection
  /** The setup note on screen; it starts as the one the bot was last published with. */
  note: string
  setNote: (note: string) => void
  /** The shown candidate was built from the picks on screen, so Publish never sends other picks. */
  committed: boolean
  building: boolean
  error: string | null
  /** Builds again with these picks; resolves to the new candidate, or null when it failed or was replaced.
   *  A pick lists the skills this sheet last listed; `fresh` (a publish retry) reads them again, with its note. */
  select: (
    change: Partial<PhoneShareSelection>,
    fresh?: { setupNote: string }
  ) => Promise<PhoneShareCandidate | null>
  rebuild: () => void
}

/** `last`: a bot with a live link starts from the picks and note it was last published with;
 *  `defaults`: one without starts with memory off; `local`: the link isn't read yet. */
export type PhoneShareCandidateSource = 'last' | 'defaults' | 'local'

export function usePhoneBotShareCandidate(
  client: RpcClient | null,
  botId: string,
  startFrom: PhoneShareCandidateSource
): PhoneShareCandidateState {
  const [built, setBuilt] = useState<{
    candidate: PhoneShareCandidate
    selection: PhoneShareSelection
  } | null>(null)
  const [selection, setSelection] = useState<PhoneShareSelection>({})
  const [note, setNoteState] = useState('')
  const noteRef = useRef('')
  const noteEdited = useRef(false)
  const [building, setBuilding] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const setNote = useCallback((next: string) => {
    noteRef.current = next
    setNoteState(next)
  }, [])

  const build = useCallback(
    async (
      next: PhoneShareSelection,
      source: PhoneShareCandidateSource,
      setupNote?: string,
      reuseSkills = false
    ): Promise<PhoneShareCandidate | null> => {
      if (!client) {
        return null
      }
      const current = ++generation.current
      setBuilding(true)
      setError(null)
      let result: Awaited<ReturnType<typeof botSharePrepare.interpret>>
      try {
        result = botSharePrepare.interpret(
          await botSharePrepare.request(client, {
            botId,
            ...next,
            ...(source === 'last'
              ? { last: true }
              : {
                  setupNote: setupNote ?? noteRef.current,
                  ...(source === 'local' ? { localOnly: true } : {}),
                  ...(reuseSkills ? { reuseSkills: true } : {})
                })
          })
        )
      } catch (cause) {
        if (generation.current === current) {
          setBuilding(false)
          setError(botShareErrorMessage(cause))
        }
        return null
      }
      if (generation.current !== current) {
        return null
      }
      setBuilding(false)
      const picked = result.last?.selection ?? next
      if (result.last) {
        setSelection(picked)
        if (!noteEdited.current) {
          setNote(result.last.setupNote)
        }
      }
      setBuilt({ candidate: result.candidate, selection: picked })
      return result.candidate
    },
    [client, botId, setNote]
  )

  // A link read after the first build: a shared bot builds again from its last picks.
  const [begin, setBegin] = useState(startFrom)
  if (begin === 'local' && startFrom === 'last' && Object.keys(selection).length === 0) {
    setBegin('last')
    setBuilt(null)
  }
  useEffect(() => {
    void build({}, begin)
    return () => {
      generation.current += 1
    }
  }, [build, begin])

  const source = startFrom === 'local' ? 'local' : 'defaults'
  return {
    candidate: built?.candidate ?? null,
    selection,
    note,
    setNote: (next) => {
      noteEdited.current = true
      setNote(next)
    },
    committed:
      built !== null &&
      !building &&
      !error &&
      JSON.stringify(built.selection) === JSON.stringify(selection),
    building,
    error,
    select: (change, fresh) => {
      const next = { ...selection, ...change }
      setSelection(next)
      return fresh ? build(next, source, fresh.setupNote) : build(next, source, undefined, true)
    },
    rebuild: () => void build(selection, !built && begin === 'last' ? 'last' : source)
  }
}
