import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertPairedBrowserFileUrlAllowed,
  guardPairedBrowserNavigation,
  type BrowserFileUrlWorktreeTarget
} from './browser-file-url-confinement'

let root: string
let outside: string
let worktree: BrowserFileUrlWorktreeTarget & { path: string }

// Real directories, because the check resolves both sides with realpath.
beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-file-url-')))
  root = path.join(base, 'workspace')
  outside = path.join(base, 'outside')
  await mkdir(path.join(root, 'build'), { recursive: true })
  await mkdir(path.join(base, 'workspace-secrets'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(root, 'build', 'report.html'), '<h1>artifact</h1>')
  await writeFile(path.join(outside, 'id_rsa'), 'secret')
  await writeFile(path.join(base, 'workspace-secrets', 'env'), 'secret')
  await symlink(path.join(outside, 'id_rsa'), path.join(root, 'escape-link'))
  await symlink(path.join(outside, 'missing'), path.join(root, 'dangling-link'))
  worktree = { id: 'wt-1', path: root, hostId: 'local' }
})

function assertAllowed(url: string, target = worktree): Promise<void> {
  return assertPairedBrowserFileUrlAllowed({ url, pairedCaller: true, worktree: target })
}

describe('paired browser file: confinement', () => {
  it('allows a file inside the workspace root, the native HTML-artifact open', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString())
    ).resolves.toBeUndefined()
  })

  it('refuses a path outside the workspace root', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(outside, 'id_rsa')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a sibling directory that shares the root prefix', async () => {
    await expect(assertAllowed(`${pathToFileURL(root).toString()}-secrets/env`)).rejects.toThrow(
      /outside the requested workspace/
    )
  })

  // `%2e` is an encoded dot: new URL() collapses it into a real `..` segment before the guard
  // ever runs, so this pins the parser's behaviour, not the containment check.
  it('refuses a dot-segment traversal the URL parser collapses for us', async () => {
    await expect(
      assertAllowed(`${pathToFileURL(root).toString()}/%2e%2e/outside/id_rsa`)
    ).rejects.toThrow(/outside the requested workspace/)
  })

  // Why this one is the real test: `%2f` is an encoded separator, which survives the parser and
  // reaches the guard as a literal in the pathname. A string prefix check reads it as inside.
  //
  // It escapes to a file that EXISTS on purpose. An over-traversal to a missing path would be
  // refused by the existence requirement instead, which would prove nothing about containment.
  it('refuses a percent-encoded separator traversal onto a real file outside the root', async () => {
    const url = `${pathToFileURL(root).toString()}%2f..%2foutside%2fid_rsa`
    expect(new URL(url).pathname).toContain('%2f')
    expect(existsSync(path.join(outside, 'id_rsa'))).toBe(true)
    await expect(assertAllowed(url)).rejects.toThrow(/outside the requested workspace/)
  })

  // The shape the reviewer drove live, escaping the workspace entirely onto a system file.
  it('refuses the %2f traversal shape reproduced against the previous head', async () => {
    const depth = root.split(path.sep).filter(Boolean).length
    const url = `${pathToFileURL(root).toString()}${'%2f..'.repeat(depth)}%2fetc/hosts`
    expect(new URL(url).pathname).toContain('%2f')
    await expect(assertAllowed(url)).rejects.toThrow(/outside the requested workspace/)
  })

  // Why: the containment check is lexical, so a link inside the root reads as inside it.
  it('refuses a symlink inside the root that points outside it', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'escape-link')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a dangling symlink inside the root', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'dangling-link')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a file that does not exist', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'absent.html')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a file: create with no workspace to confine it to', async () => {
    await expect(
      assertPairedBrowserFileUrlAllowed({
        url: 'file:///etc/passwd',
        pairedCaller: true,
        worktree: undefined
      })
    ).rejects.toThrow(/requires an explicit workspace/)
  })

  it('refuses a workspace whose host was never stamped, rather than assuming local', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString(), {
        id: 'wt-1',
        path: root
      })
    ).rejects.toThrow(/remote workspace/)
  })

  it('refuses a remote workspace, whose path names another machine', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString(), {
        ...worktree,
        hostId: 'ssh:box'
      } as typeof worktree)
    ).rejects.toThrow(/remote workspace/)
  })

  it('allows a folder workspace on the local host', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString(), {
        id: 'folder-1',
        path: root,
        hostId: 'local'
      } as typeof worktree)
    ).resolves.toBeUndefined()
  })

  it('leaves http(s) and local callers alone', async () => {
    await expect(
      assertPairedBrowserFileUrlAllowed({
        url: 'https://example.com',
        pairedCaller: true,
        worktree: undefined
      })
    ).resolves.toBeUndefined()
    await expect(
      assertPairedBrowserFileUrlAllowed({
        url: 'file:///etc/passwd',
        pairedCaller: false,
        worktree: undefined
      })
    ).resolves.toBeUndefined()
  })
})

describe('guardPairedBrowserNavigation', () => {
  const guard = (over: Partial<Parameters<typeof guardPairedBrowserNavigation>[0]> = {}) =>
    guardPairedBrowserNavigation({
      url: pathToFileURL(path.join(outside, 'id_rsa')).toString(),
      pairedCaller: true,
      resolveWorktree: async () => worktree,
      ...over
    })

  it('refuses an outside file: URL for a paired caller', async () => {
    await expect(guard()).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a paired file: URL that names no workspace', async () => {
    await expect(guard({ resolveWorktree: async () => undefined })).rejects.toThrow(
      /requires an explicit workspace/
    )
  })

  // Why exempt: that page renders on the caller's own device against its own disk, and
  // browser-host-client-page-creation refuses a lease belonging to another device, so this is
  // never a read of someone else's files. The host's root is the wrong root to judge it by.
  it('exempts client placement, which renders on the caller device', async () => {
    await expect(guard({ placementKind: 'client' })).resolves.toBeUndefined()
  })

  it('never resolves a workspace for an http(s) or unpaired navigation', async () => {
    const resolveWorktree = vi.fn(async () => worktree)
    await expect(guard({ url: 'https://example.com', resolveWorktree })).resolves.toBeUndefined()
    await expect(guard({ pairedCaller: false, resolveWorktree })).resolves.toBeUndefined()
    expect(resolveWorktree).not.toHaveBeenCalled()
  })
})
