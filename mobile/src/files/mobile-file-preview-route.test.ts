import { describe, expect, it } from 'vitest'
import {
  createMobileFilePreviewHref,
  displayNameFromPreviewPath,
  normalizeMobileFilePreviewRouteParams
} from './mobile-file-preview-route'

describe('mobile-file-preview-route', () => {
  it('normalizes valid route params without changing encoded-sensitive path characters', () => {
    const relativePath = 'docs/a #b?c%25 d\\note.md'
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath,
      name: 'note.md',
      worktreeName: 'Orca'
    })

    expect(route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'note.md',
        worktreeName: 'Orca'
      }
    })
  })

  it('rejects missing, empty, or array-valued required params', () => {
    expect(normalizeMobileFilePreviewRouteParams({ hostId: 'h', worktreeId: 'w' })).toEqual({
      ok: false,
      message: 'Unable to load preview'
    })
    expect(
      normalizeMobileFilePreviewRouteParams({
        hostId: 'h',
        worktreeId: 'w',
        relativePath: ''
      })
    ).toEqual({ ok: false, message: 'Unable to load preview' })
    expect(
      normalizeMobileFilePreviewRouteParams({
        hostId: 'h',
        worktreeId: 'w',
        relativePath: ['a.ts', 'b.ts']
      })
    ).toEqual({ ok: false, message: 'Unable to load preview' })
  })

  it('builds the Expo href object so Expo owns URL encoding', () => {
    const relativePath = 'src/#hash ?query%20\\file.ts'

    expect(
      createMobileFilePreviewHref({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'file.ts'
      })
    ).toEqual({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        name: 'file.ts'
      }
    })
  })

  it('derives display names from slash or backslash paths only for display', () => {
    expect(displayNameFromPreviewPath('src/app.ts')).toBe('app.ts')
    expect(displayNameFromPreviewPath('src\\app.ts')).toBe('app.ts')
  })
})
