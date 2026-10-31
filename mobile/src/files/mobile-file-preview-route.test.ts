import { describe, expect, it } from 'vitest'
import {
  displayNameFromPreviewPath,
  mobileFilePreviewShellParams,
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
        source: 'worktree',
        line: undefined,
        column: undefined,
        name: 'note.md',
        worktreeName: 'Orca'
      }
    })
  })

  it('normalizes worktree preview line and column params', () => {
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'src/app.ts',
      line: '120',
      column: '7'
    })

    expect(route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'src/app.ts',
        source: 'worktree',
        line: '120',
        column: '7',
        name: undefined,
        worktreeName: undefined
      }
    })
  })

  it('normalizes terminal artifact params without requiring a relative path', () => {
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      source: 'terminalArtifact',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1',
      terminal: 'term-1',
      pathText: 'result.json',
      cwd: '/tmp/run',
      nativeChatTab: 'tab-1',
      nativeChatSession: 'session-1',
      line: '12',
      column: '3'
    })

    expect(route).toEqual({
      ok: true,
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'terminalArtifact',
        absolutePath: '/tmp/result.json',
        grantId: 'grant-1',
        terminal: 'term-1',
        pathText: 'result.json',
        cwd: '/tmp/run',
        nativeChatTab: 'tab-1',
        nativeChatSession: 'session-1',
        line: '12',
        column: '3'
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

  it('hands the shell every param but the two the pathname spells as segments', () => {
    expect(
      mobileFilePreviewShellParams({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'docs/my notes/readme.md',
        source: 'worktree',
        line: '12'
      })
    ).toEqual({ relativePath: 'docs/my notes/readme.md', source: 'worktree', line: '12' })
  })

  it('leaves an absent param out rather than sending it empty', () => {
    // Use the real normalizer, which emits optional keys as undefined; a hand-written literal would miss this case.
    // Omit absent params: the page distinguishes missing line (open at top) from line:"" (scroll nowhere).
    const route = normalizeMobileFilePreviewRouteParams({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      relativePath: 'readme.md'
    })
    if (!route.ok) {
      throw new Error(route.message)
    }
    expect('line' in route.params).toBe(true)
    expect(mobileFilePreviewShellParams(route.params)).toEqual({
      relativePath: 'readme.md',
      source: 'worktree'
    })
  })

  it('carries a terminal artifact by its absolute path, which is not a segment either', () => {
    expect(
      mobileFilePreviewShellParams({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'terminalArtifact',
        absolutePath: '/logs/run 1.txt',
        grantId: 'grant-1',
        cwd: '/logs'
      })
    ).toEqual({
      source: 'terminalArtifact',
      absolutePath: '/logs/run 1.txt',
      grantId: 'grant-1',
      cwd: '/logs'
    })
  })

  it('derives display names from slash or backslash paths only for display', () => {
    expect(displayNameFromPreviewPath('src/app.ts')).toBe('app.ts')
    expect(displayNameFromPreviewPath('src\\app.ts')).toBe('app.ts')
  })
})
