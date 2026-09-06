import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __setWindowsProcessTreeLoaderForTests,
  resetWindowsProcessTableForTests
} from '../windows/windows-process-table'
import { supportsClaudeStructuredLocation } from './claude-structured-location-support'

function setPlatform(platform: NodeJS.Platform): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return previous
}

describe('supportsClaudeStructuredLocation', () => {
  let previousPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    previousPlatform = setPlatform('darwin')
    __setWindowsProcessTreeLoaderForTests()
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    resetWindowsProcessTableForTests()
    if (previousPlatform) {
      Object.defineProperty(process, 'platform', previousPlatform)
    }
  })

  it('allows local non-WSL locations on macOS and Linux', () => {
    expect(
      supportsClaudeStructuredLocation({
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      })
    ).toBe(true)
  })

  it('rejects Windows local locations until creation-time proof is available', () => {
    previousPlatform = setPlatform('win32')
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses: () => undefined
    }))
    expect(
      supportsClaudeStructuredLocation({
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      })
    ).toBe(false)
  })

  it('accepts Windows local locations once creation-time proof is available', () => {
    previousPlatform = setPlatform('win32')
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2, CreationTime: 4 },
      getAllProcesses: () => undefined
    }))
    expect(
      supportsClaudeStructuredLocation({
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      })
    ).toBe(true)
  })

  it('rejects WSL and remote locations', () => {
    expect(
      supportsClaudeStructuredLocation({
        executionHostId: 'local',
        wslDistro: 'Ubuntu',
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      })
    ).toBe(false)
    expect(
      supportsClaudeStructuredLocation({
        executionHostId: 'runtime:env-1',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      })
    ).toBe(false)
  })
})
