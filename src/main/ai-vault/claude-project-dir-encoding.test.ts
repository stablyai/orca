import { describe, expect, it } from 'vitest'
import {
  encodeClaudeProjectPath,
  encodeClaudeProjectPaths,
  isClaudeProjectDirInScope
} from './claude-project-dir-encoding'

describe('encodeClaudeProjectPath', () => {
  it('emits one dash per non-alphanumeric character rather than per run', () => {
    // The distinction is the whole contract: collapsing runs stops matching real bucket names.
    expect(encodeClaudeProjectPath('/Users/ada/orca/workspaces')).toBe('-Users-ada-orca-workspaces')
    expect(encodeClaudeProjectPath('/Users/ada/.orca/worktrees')).toBe('-Users-ada--orca-worktrees')
  })

  it('encodes a Windows drive path', () => {
    expect(encodeClaudeProjectPath('C:\\Users\\ada\\orca\\workspaces')).toBe(
      'C--Users-ada-orca-workspaces'
    )
    expect(encodeClaudeProjectPath('C:\\')).toBe('C--')
  })

  it('encodes a WSL drvfs mount separately from the Windows drive spelling', () => {
    // Claude in WSL records cwd as /mnt/c/... even when Orca's worktree is C:\...
    expect(encodeClaudeProjectPath('/mnt/c/Users/neil/orca/orca')).toBe(
      '-mnt-c-Users-neil-orca-orca'
    )
    expect(encodeClaudeProjectPath('C:\\Users\\neil\\orca\\orca')).toBe('C--Users-neil-orca-orca')
  })

  it('encodes a WSL UNC path', () => {
    expect(encodeClaudeProjectPath('\\\\wsl$\\Ubuntu\\home\\ada\\orca\\workspaces')).toBe(
      '--wsl--Ubuntu-home-ada-orca-workspaces'
    )
  })

  it('drops trailing separators but keeps a bare root', () => {
    expect(encodeClaudeProjectPath('/Users/ada/orca/')).toBe('-Users-ada-orca')
    expect(encodeClaudeProjectPath('/')).toBe('-')
  })

  it('offers the NFC spelling alongside the raw one', () => {
    const nfd = '/Users/ada/cafe\u0301'
    expect(encodeClaudeProjectPaths(nfd)).toEqual([
      encodeClaudeProjectPath(nfd),
      encodeClaudeProjectPath(nfd.normalize('NFC'))
    ])
    expect(encodeClaudeProjectPaths('/Users/ada/cafe')).toEqual(['-Users-ada-cafe'])
  })
})

describe('isClaudeProjectDirInScope', () => {
  it('accepts the prefix itself and its dash-delimited descendants', () => {
    expect(isClaudeProjectDirInScope('-w-orca', ['-w-orca'])).toBe(true)
    expect(isClaudeProjectDirInScope('-w-orca-nautilus', ['-w-orca'])).toBe(true)
  })

  it('rejects a sibling that merely starts with the prefix', () => {
    // Without the boundary, "orca" would absorb every workspace under "orcadyne".
    expect(isClaudeProjectDirInScope('-w-orcadyne-nautilus', ['-w-orca'])).toBe(false)
  })
  // Why: Windows volumes are case-insensitive, so a WSL pane whose cwd was typed
  // `/mnt/c/users/neil/orca` encodes differently from the worktree's
  // `/mnt/c/Users/Neil/orca` and was dropped at the prefix stage, before the
  // case-folding alias re-check could run (STA-4973 follow-up).
  it('matches a WSL drive-mount prefix whose Windows spelling differs in case', () => {
    const prefix = encodeClaudeProjectPath('/mnt/c/Users/Neil/orca')
    const caseInsensitive = new Set([prefix])
    expect(isClaudeProjectDirInScope('-mnt-c-users-neil-orca', [prefix], caseInsensitive)).toBe(
      true
    )
    expect(isClaudeProjectDirInScope('-mnt-c-users-neil-orca-sub', [prefix], caseInsensitive)).toBe(
      true
    )
  })

  it('matches a native Windows volume prefix whose spelling differs in case', () => {
    const prefix = encodeClaudeProjectPath('C:\\Users\\Neil\\orca')
    expect(isClaudeProjectDirInScope('c--users-neil-orca', [prefix], new Set([prefix]))).toBe(true)
  })

  it('keeps POSIX paths case-sensitive', () => {
    const prefix = encodeClaudeProjectPath('/home/neil/Orca')
    expect(isClaudeProjectDirInScope('-home-neil-orca', [prefix])).toBe(false)
  })

  it('keeps a raw POSIX /mnt/c prefix case-sensitive', () => {
    const prefix = encodeClaudeProjectPath('/mnt/c/Users/Neil/orca')
    expect(isClaudeProjectDirInScope('-mnt-c-users-neil-orca', [prefix])).toBe(false)
  })

  it('still refuses a sibling prefix under case folding', () => {
    const prefix = encodeClaudeProjectPath('/mnt/c/Users/Neil/orca')
    const caseInsensitive = new Set([prefix])
    expect(isClaudeProjectDirInScope('-mnt-c-users-neil-orcadyne', [prefix], caseInsensitive)).toBe(
      false
    )
    expect(
      isClaudeProjectDirInScope('-mnt-c-users-neil-orca-secret', [prefix], caseInsensitive)
    ).toBe(true)
  })
})
