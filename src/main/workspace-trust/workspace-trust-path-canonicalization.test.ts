import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  invalidateWorkspaceTrustPathCache,
  resolveWorkspaceTrustForPath
} from './workspace-trust-path-canonicalization'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'

function makeEntry(
  path: string,
  overrides: Partial<WorkspaceTrustEntry> = {}
): WorkspaceTrustEntry {
  return { id: 'entry-1', path, trusted: true, decidedAt: 1, origin: 'intake', ...overrides }
}

describe('resolveWorkspaceTrustForPath (real filesystem)', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    invalidateWorkspaceTrustPathCache()
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not inherit trust when a symlink inside a trusted root resolves outside it', async () => {
    const trustedRoot = mkdtempSync(join(tmpdir(), 'workspace-trust-root-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'workspace-trust-outside-'))
    cleanupDirs.push(trustedRoot, outsideDir)
    const escapingSymlink = join(trustedRoot, 'escape')
    symlinkSync(outsideDir, escapingSymlink, process.platform === 'win32' ? 'junction' : 'dir')

    const trusted = await resolveWorkspaceTrustForPath(escapingSymlink, [makeEntry(trustedRoot)])

    expect(trusted).toBe(false)
  })

  it('reports trusted for a real subdirectory of a trusted root', async () => {
    const trustedRoot = mkdtempSync(join(tmpdir(), 'workspace-trust-root-'))
    const subDir = join(trustedRoot, 'proj')
    mkdirSync(subDir)
    cleanupDirs.push(trustedRoot)

    const trusted = await resolveWorkspaceTrustForPath(subDir, [makeEntry(trustedRoot)])

    expect(trusted).toBe(true)
  })

  it('fails closed while unresolvable, then recovers on remount without a new decision', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-trust-mount-'))
    const mounted = join(parent, 'volume')
    const unmounted = join(parent, 'volume-unmounted')
    mkdirSync(mounted)
    cleanupDirs.push(parent)
    const entries = [makeEntry(mounted)]

    renameSync(mounted, unmounted)
    expect(await resolveWorkspaceTrustForPath(mounted, entries)).toBe(false)

    renameSync(unmounted, mounted)
    expect(await resolveWorkspaceTrustForPath(mounted, entries)).toBe(true)
  })
})
