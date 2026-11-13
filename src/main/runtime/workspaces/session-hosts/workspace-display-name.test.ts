import { expect, it, vi } from 'vitest'
import { OrcaRuntimeWithGetRuntimeId } from './get-runtime-id'

it.each([750, 7_500])(
  'names one workspace from its own metadata, whatever the other %i folder workspaces',
  (folders) => {
    const store = {
      getWorktreeMeta: vi.fn((id: string) =>
        id === 'repo::/workspace' ? { displayName: 'feature-x' } : undefined
      ),
      getFolderWorkspaces: vi.fn(() =>
        Array.from({ length: folders }, (_, index) => ({ id: `folder-${index}`, name: 'f' }))
      )
    }
    const name = OrcaRuntimeWithGetRuntimeId.prototype.getWorkspaceDisplayName
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only `this.store`.
    const runtime = { store } as unknown as OrcaRuntimeWithGetRuntimeId

    expect(name.call(runtime, 'repo::/workspace')).toBe('feature-x')
    expect(name.call(runtime, 'folder:folder-1')).toBeNull()
    expect(store.getFolderWorkspaces).not.toHaveBeenCalled()
  }
)
