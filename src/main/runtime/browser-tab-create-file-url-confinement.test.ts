import { describe, expect, it } from 'vitest'
import { assertPairedBrowserTabCreateFileUrlAllowed } from './browser-tab-create-file-url-confinement'

const WORKTREE = { id: 'wt-1', path: '/Users/dev/code/orca' }

describe('paired browser.tabCreate file: confinement', () => {
  it('allows a file inside the workspace root, the native HTML-artifact open', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///Users/dev/code/orca/build/report.html',
        pairedCaller: true,
        worktree: WORKTREE
      })
    ).not.toThrow()
  })

  it('refuses a path outside the workspace root', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///Users/dev/.ssh/id_rsa',
        pairedCaller: true,
        worktree: WORKTREE
      })
    ).toThrow(/outside the requested workspace/)
  })

  it('refuses a sibling directory that shares the root prefix', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///Users/dev/code/orca-secrets/env',
        pairedCaller: true,
        worktree: WORKTREE
      })
    ).toThrow(/outside the requested workspace/)
  })

  it('refuses a traversal escape that percent-encodes its separators', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///Users/dev/code/orca/%2e%2e/%2e%2e/.ssh/id_rsa',
        pairedCaller: true,
        worktree: WORKTREE
      })
    ).toThrow(/outside the requested workspace/)
  })

  it('refuses a file: create with no workspace to confine it to', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///etc/passwd',
        pairedCaller: true,
        worktree: undefined
      })
    ).toThrow(/requires an explicit workspace/)
  })

  it('refuses a remote workspace, whose path names another machine', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///Users/dev/code/orca/build/report.html',
        pairedCaller: true,
        worktree: { ...WORKTREE, hostId: 'ssh:box' }
      })
    ).toThrow(/remote workspace/)
  })

  it('allows a folder workspace on the local host', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///Users/dev/notes/index.html',
        pairedCaller: true,
        worktree: { id: 'folder-1', path: '/Users/dev/notes', hostId: 'local' }
      })
    ).not.toThrow()
  })

  it('leaves http(s) and local callers alone', () => {
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'https://example.com',
        pairedCaller: true,
        worktree: undefined
      })
    ).not.toThrow()
    expect(() =>
      assertPairedBrowserTabCreateFileUrlAllowed({
        url: 'file:///etc/passwd',
        pairedCaller: false,
        worktree: undefined
      })
    ).not.toThrow()
  })
})
