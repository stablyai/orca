import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { RepoIcon } from '../../../shared/repo-icon'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    state: { settings: {}, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

// The renderer draws this icon on every project surface, including as an <img src>, so the store
// boundary — not the settings UI — is what has to refuse an unusable payload.
describe('updateSettings defaultProjectIcon', () => {
  it('persists a supported icon and its color', () => {
    const operations = makeOperations()

    const settings = updateSettings(operations, {
      defaultProjectIcon: { type: 'lucide', name: 'Folder' },
      defaultProjectIconColor: '#E11D48'
    })

    expect(settings.defaultProjectIcon).toEqual({ type: 'lucide', name: 'Folder' })
    expect(settings.defaultProjectIconColor).toBe('#e11d48')
  })

  it('clears the default when the Avatar tab is chosen', () => {
    const operations = makeOperations()

    updateSettings(operations, { defaultProjectIcon: { type: 'emoji', emoji: '🐳' } })

    expect(updateSettings(operations, { defaultProjectIcon: null }).defaultProjectIcon).toBeNull()
  })

  it('drops an unsupported icon back to the avatar instead of storing it', () => {
    const operations = makeOperations()

    expect(
      updateSettings(operations, {
        defaultProjectIcon: { type: 'image', src: 'javascript:alert(1)', source: 'github' }
      }).defaultProjectIcon
    ).toBeNull()
    expect(
      updateSettings(operations, {
        defaultProjectIcon: { type: 'lucide', name: '../../etc' } as RepoIcon
      }).defaultProjectIcon
    ).toBeNull()
  })

  it('ignores a color that is not a hex value', () => {
    const operations = makeOperations()

    expect(
      updateSettings(operations, { defaultProjectIconColor: 'red' }).defaultProjectIconColor
    ).toBeUndefined()
  })
})
