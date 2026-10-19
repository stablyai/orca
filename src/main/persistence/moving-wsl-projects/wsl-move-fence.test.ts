import { describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoveFenceFromCutovers } from './wsl-move-fence'

const ids = (state: ReturnType<typeof wslMoveFenceFromCutovers>) => ({
  fenced: [...state.fenced.repoIds, ...state.fenced.folderWorkspaceIds],
  hidden: [...state.hidden.repoIds, ...state.hidden.folderWorkspaceIds],
  sessionFrozen: [...state.sessionFrozen.repoIds, ...state.sessionFrozen.folderWorkspaceIds]
})

describe('WSL move fence', () => {
  it.each([
    ['prepared', { fenced: [], hidden: [], sessionFrozen: [] }],
    // The quiesce's own Sleep still writes the session here.
    ['source-fenced', { fenced: ['repo-1', 'notes'], hidden: [], sessionFrozen: [] }],
    ['quiesced', { fenced: ['repo-1', 'notes'], hidden: [], sessionFrozen: ['repo-1', 'notes'] }],
    [
      'blobs-transferred',
      { fenced: ['repo-1', 'notes'], hidden: [], sessionFrozen: ['repo-1', 'notes'] }
    ],
    // Through commit: the retained local session is what a downgrade restores.
    [
      'destination-committed',
      { fenced: [], hidden: ['repo-1', 'notes'], sessionFrozen: ['repo-1', 'notes'] }
    ],
    [
      'client-rewritten',
      { fenced: [], hidden: ['repo-1', 'notes'], sessionFrozen: ['repo-1', 'notes'] }
    ],
    ['retained', { fenced: [], hidden: ['repo-1', 'notes'], sessionFrozen: ['repo-1', 'notes'] }]
  ] as const)('%s', (phase, expected) => {
    const record = cutover(
      'move-1',
      phase,
      {},
      { repoIds: ['repo-1'], folderWorkspaceIds: ['notes'] }
    )
    expect(ids(wslMoveFenceFromCutovers([record]))).toEqual(expected)
  })

  it('fences only what each move names', () => {
    const state = wslMoveFenceFromCutovers([
      cutover('move-1', 'retained', {}, { repoIds: ['repo-1'] }),
      cutover('move-2', 'quiesced', { supersedesMigrationId: 'move-1' }, { repoIds: ['repo-2'] })
    ])
    expect(ids(state)).toEqual({
      fenced: ['repo-2'],
      hidden: ['repo-1'],
      sessionFrozen: ['repo-1', 'repo-2']
    })
  })
})
