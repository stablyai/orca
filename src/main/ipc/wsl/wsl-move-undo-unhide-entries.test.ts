import { describe, expect, it, vi } from 'vitest'
import {
  getDefaultUIState,
  getDefaultWorkspaceSession
} from '../../../shared/orca-profiles/constants'
import { wslMoveCutoverFixture } from '../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

function storeWithHidden(hiddenWslMovedProjectKeys: string[]) {
  return {
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    patchWorkspaceSession: vi.fn(),
    listAutomations: () => [],
    updateAutomation: vi.fn(),
    getUI: () => ({ ...getDefaultUIState(), hiddenWslMovedProjectKeys }),
    updateUI: vi.fn()
  }
}

describe("undo forgets its projects' hidden sidebar entries", () => {
  // Without this a later move of the same project to the same distro would list hidden.
  it("drops only the released move's projects, matching the distro case-insensitively", () => {
    const store = storeWithHidden([
      'ubuntu\u0000repo:repo-a',
      'Ubuntu\u0000folder:folder-a',
      'Ubuntu\u0000repo:repo-other',
      'Debian\u0000repo:repo-a'
    ])
    const move = wslMoveCutoverFixture(
      'move-1',
      'retained',
      {},
      { repoIds: ['repo-a'], folderWorkspaceIds: ['folder-a'] }
    )
    createWslMoveUndoPorts(store, '/user-data').unhideMovedEntries?.(move)
    expect(store.updateUI).toHaveBeenCalledWith({
      hiddenWslMovedProjectKeys: ['Ubuntu\u0000repo:repo-other', 'Debian\u0000repo:repo-a']
    })
  })

  it('writes nothing when none of its projects were hidden', () => {
    const store = storeWithHidden(['Ubuntu\u0000repo:repo-other'])
    const move = wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: ['repo-a'] })
    createWslMoveUndoPorts(store, '/user-data').unhideMovedEntries?.(move)
    expect(store.updateUI).not.toHaveBeenCalled()
  })
})
