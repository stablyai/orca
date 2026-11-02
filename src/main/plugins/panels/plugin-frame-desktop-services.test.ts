import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }))
vi.mock('../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

const { saveDialogFilters } = await import('./plugin-frame-desktop-services')

describe('save dialog filters', () => {
  it("follow the suggested name's extension, whatever the MIME type", () => {
    expect(saveDialogFilters('scene.excalidraw')).toEqual([
      { name: 'EXCALIDRAW', extensions: ['excalidraw'] },
      { name: 'All Files', extensions: ['*'] }
    ])
    expect(saveDialogFilters('download')).toBeUndefined()
  })
})
