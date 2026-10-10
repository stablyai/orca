import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(settings: Partial<GlobalSettings>): SettingsMutationOperations {
  const state = {
    settings: { workspaceDir: '/workspaces', workspaceDirHistory: [], ...settings },
    repos: []
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields updateSettings reads for these settings.
    state: state as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

// Every writer (desktop IPC, web RPC, CLI) crosses this boundary, so the persisted pair stays
// coherent for builds that only read nestWorkspaces.
describe('updateSettings worktreeLayout', () => {
  it('leaves a legacy profile without a layout untouched by unrelated writes', () => {
    const operations = makeOperations({ nestWorkspaces: false })

    const result = updateSettings(operations, { workspaceDir: '/elsewhere' })

    expect(result.worktreeLayout).toBeUndefined()
    expect(result.nestWorkspaces).toBe(false)
  })

  it('mirrors nested and flat into nestWorkspaces and records the previous layout', () => {
    const operations = makeOperations({ nestWorkspaces: true })

    const result = updateSettings(operations, { worktreeLayout: 'flat' }, { notifyListeners: true })

    expect(result).toMatchObject({ worktreeLayout: 'flat', nestWorkspaces: false })
    expect(result.workspaceDirHistory).toEqual([{ path: '/workspaces', nestWorkspaces: true }])
    expect(operations.notifySettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeLayout: 'flat', nestWorkspaces: false }),
      undefined
    )
  })

  it('keeps the last workspace-directory boolean when switching to sibling', () => {
    const operations = makeOperations({ nestWorkspaces: true })

    const result = updateSettings(operations, { worktreeLayout: 'sibling' })

    expect(result).toMatchObject({ worktreeLayout: 'sibling', nestWorkspaces: true })
    expect(result.workspaceDirHistory).toEqual([])
  })

  it('lets a boolean-only writer leave sibling for nested or flat', () => {
    const operations = makeOperations({ nestWorkspaces: true, worktreeLayout: 'sibling' })

    expect(updateSettings(operations, { nestWorkspaces: false })).toMatchObject({
      worktreeLayout: 'flat',
      nestWorkspaces: false
    })
  })

  it('drops an unknown layout value so the boolean decides', () => {
    const operations = makeOperations({ nestWorkspaces: true, worktreeLayout: 'sibling' })

    const result = updateSettings(operations, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a hand-built client can send any JSON; the boundary must coerce it.
      worktreeLayout: 'beside' as unknown as GlobalSettings['worktreeLayout']
    })

    expect(result.worktreeLayout).toBeUndefined()
    expect(result.nestWorkspaces).toBe(true)
  })
})
