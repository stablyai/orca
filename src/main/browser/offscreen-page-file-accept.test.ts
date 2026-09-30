import { describe, expect, it } from 'vitest'
import { fileDialogFiltersForAccept } from './offscreen-page-file-accept'

describe('fileDialogFiltersForAccept', () => {
  it('offers no filter when accept names nothing known', () => {
    expect(fileDialogFiltersForAccept('')).toEqual([])
    expect(fileDialogFiltersForAccept('application/x-unknown')).toEqual([])
  })

  it('names a wildcard type after its family', () => {
    const [filter, all] = fileDialogFiltersForAccept('image/*')
    expect(filter.name).toBe('Image Files')
    expect(filter.extensions).toEqual(expect.arrayContaining(['png', 'jpg', 'webp']))
    expect(all).toEqual({ name: 'All Files', extensions: ['*'] })
  })

  it('names one extension after itself and mixed types "Custom Files"', () => {
    expect(fileDialogFiltersForAccept('.CSV')[0]).toEqual({
      name: 'CSV Files',
      extensions: ['csv']
    })
    expect(fileDialogFiltersForAccept('image/jpeg')[0].name).toBe('Custom Files')
    expect(fileDialogFiltersForAccept('.pdf, application/json')[0]).toEqual({
      name: 'Custom Files',
      extensions: ['pdf', 'json']
    })
  })
})
