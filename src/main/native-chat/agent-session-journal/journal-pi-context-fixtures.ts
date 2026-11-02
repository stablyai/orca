const timestamp = '2026-10-12T12:00:00.000Z'

function turn(id: string, parentId: string | null, text = id, role = 'user') {
  return { type: 'message', id, parentId, timestamp, message: { role, content: text } }
}

function compact(id: string, parentId: string, firstKeptEntryId: string | null) {
  return {
    type: 'compaction',
    id,
    parentId,
    timestamp,
    firstKeptEntryId,
    summary: id,
    tokensBefore: 100
  }
}

const root = turn('root', null)
const kept = turn('kept', 'root')
const checkpoint = compact('summary', 'kept', 'kept')
const later = turn('later', 'summary', 'later', 'assistant')

// Verified against Pi 1.1.0 buildContextEntries/sessionEntryToContextMessages.
export const PI_CONTEXT_FIXTURES = [
  {
    name: 'kept range before latest compaction',
    entries: [root, kept, checkpoint, later],
    texts: ['summary', 'kept', 'later']
  },
  {
    name: 'branch summary with metadata leaf omits abandoned branch',
    entries: [
      root,
      turn('abandoned', 'root'),
      {
        type: 'branch_summary',
        id: 'branch',
        parentId: 'root',
        fromId: 'abandoned',
        summary: 'branch',
        timestamp
      },
      {
        type: 'label',
        id: 'label',
        parentId: 'branch',
        targetId: 'branch',
        label: 'saved',
        timestamp
      }
    ],
    texts: ['root', 'branch']
  },
  {
    name: 'version 1 migration uses parsed file index including header',
    version: 1,
    entries: [
      { type: 'message', message: { role: 'user', content: 'root' }, timestamp },
      { type: 'model_change', provider: 'test', modelId: 'test', timestamp },
      { type: 'message', message: { role: 'user', content: 'kept' }, timestamp },
      {
        type: 'compaction',
        firstKeptEntryIndex: 3,
        summary: 'summary',
        tokensBefore: 100,
        timestamp
      },
      { type: 'message', message: { role: 'assistant', content: 'later' }, timestamp }
    ],
    texts: ['summary', 'kept', 'later']
  }
]
