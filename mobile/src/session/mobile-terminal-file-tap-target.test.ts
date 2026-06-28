import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalPathResolution } from '../../../src/shared/runtime-types'
import { getMobileTerminalFileTapTarget } from './mobile-terminal-file-tap-target'

function resolved(
  overrides: Partial<RuntimeTerminalPathResolution>
): RuntimeTerminalPathResolution {
  return {
    worktree: 'wt-1',
    relativePath: 'src/app.ts',
    absolutePath: '/repo/src/app.ts',
    exists: true,
    isDirectory: false,
    ...overrides
  }
}

describe('getMobileTerminalFileTapTarget', () => {
  it('opens ordinary files in the mobile preview route', () => {
    expect(
      getMobileTerminalFileTapTarget({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        worktreeName: 'Orca',
        resolved: resolved({ relativePath: 'src/app.ts', absolutePath: '/repo/src/app.ts' })
      })
    ).toEqual({
      kind: 'preview',
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'src/app.ts',
        name: 'app.ts',
        worktreeName: 'Orca'
      }
    })
  })

  it('opens images in the same mobile preview route', () => {
    expect(
      getMobileTerminalFileTapTarget({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        resolved: resolved({
          relativePath: 'artifacts/screenshot.png',
          absolutePath: '/repo/artifacts/screenshot.png'
        })
      })
    ).toEqual({
      kind: 'preview',
      params: {
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath: 'artifacts/screenshot.png',
        name: 'screenshot.png',
        worktreeName: undefined
      }
    })
  })

  it('keeps HTML on the browser path when an absolute file URL is available', () => {
    expect(
      getMobileTerminalFileTapTarget({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        resolved: resolved({ relativePath: 'report.html', absolutePath: '/repo/report.html' })
      })
    ).toEqual({ kind: 'browser', url: 'file:///repo/report.html' })
  })

  it('ignores missing files, directories, and paths outside the worktree', () => {
    expect(
      getMobileTerminalFileTapTarget({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        resolved: resolved({ exists: false })
      })
    ).toEqual({ kind: 'ignore' })
    expect(
      getMobileTerminalFileTapTarget({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        resolved: resolved({ isDirectory: true })
      })
    ).toEqual({ kind: 'ignore' })
    expect(
      getMobileTerminalFileTapTarget({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        resolved: resolved({ relativePath: null })
      })
    ).toEqual({ kind: 'ignore' })
  })
})
