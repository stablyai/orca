import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  newWorkspaceRepoHooksSchema,
  newWorkspaceUiTrustSchema,
  repoAddReplySchema,
  serverDirectoryBrowseReplySchema
} from './new-workspace-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

describe('the drawer requires only what it reads unguarded', () => {
  it('requires the hook source the drawer assigns straight into its details', () => {
    const reply = { hooks: { scripts: { setup: 'pnpm i' } }, source: 'repo', setupTrust: null }
    expect(reads(newWorkspaceRepoHooksSchema, reply).source).toBe('repo')
    expect(refuses(newWorkspaceRepoHooksSchema, { hooks: null })).toBe(true)
    expect(refuses(newWorkspaceRepoHooksSchema, { error: 'refused' })).toBe(true)
    expect(refuses(newWorkspaceRepoHooksSchema, null)).toBe(true)
  })

  it('preserves an explicit null source rather than collapsing it to absent', () => {
    expect(reads(newWorkspaceRepoHooksSchema, { hooks: null, source: null }).source).toBe(null)
  })

  it('takes the recorded reply with an explicit null setupTrust without salvaging it', () => {
    // The components-setup-ask fixture sends `setupTrust: null`; treating that as a malformed
    // member would report a drop on a reply the host really sends.
    const reply = { hooks: null, source: null, setupRunPolicy: 'ask', setupTrust: null }
    expect(reads(newWorkspaceRepoHooksSchema, reply).setupTrust).toBe(null)
  })

  it('drops a setupTrust missing the members normalizeSetupHookTrust reads', () => {
    const reply = { source: null, setupTrust: { contentHash: 7, scriptContent: 'x' } }
    expect(reads(newWorkspaceRepoHooksSchema, reply).setupTrust).toBe(undefined)
  })
})

describe('the setup run policy is a closed enum with the call site defaulting it', () => {
  it('drops an arm this build does not know, which behaves as run-by-default did', () => {
    expect(
      reads(newWorkspaceRepoHooksSchema, { source: null, setupRunPolicy: 'on-tuesdays' })
        .setupRunPolicy
    ).toBe(undefined)
  })
})

describe('the trust record salvages per repo', () => {
  it('keeps the approvals isSetupHookTrusted reads', () => {
    const ui = { trustedOrcaHooks: { 'repo-1': { setup: { contentHash: 'h', approvedAt: 1 } } } }
    expect(reads(newWorkspaceUiTrustSchema, { ui })?.trustedOrcaHooks?.['repo-1']?.setup).toEqual({
      contentHash: 'h',
      approvedAt: 1
    })
  })

  it('drops one unreadable repo without costing the others their trust', () => {
    const ui = {
      trustedOrcaHooks: {
        'repo-1': { all: { approvedAt: 1 } },
        'repo-2': 'not-a-record'
      }
    }
    const trust = reads(newWorkspaceUiTrustSchema, { ui })?.trustedOrcaHooks
    expect(trust?.['repo-1']?.all).toEqual({ approvedAt: 1 })
    expect(trust?.['repo-2']).toBe(undefined)
  })

  it('reads a null or absent ui the way the drawer always has', () => {
    expect(reads(newWorkspaceUiTrustSchema, null)).toBe(undefined)
    expect(reads(newWorkspaceUiTrustSchema, {})).toBe(undefined)
    expect(reads(newWorkspaceUiTrustSchema, { ui: null })).toBe(null)
  })

  // The call site interprets this reply inside an unawaited `void (async () => {})()` with no
  // catch, so a refusal here is an unhandled rejection that also skips the provider computation
  // below it. Main cast the value and read `?.trustedOrcaHooks ?? {}`, which tolerated any shape.
  it('reads a non-object ui.get result as absent rather than refusing it', () => {
    for (const value of ['not-an-object', 42, true, [], [{ ui: {} }]]) {
      expect(refuses(newWorkspaceUiTrustSchema, value)).toBe(false)
      expect(reads(newWorkspaceUiTrustSchema, value)).toBe(undefined)
    }
  })
})

describe('serverDirectoryBrowseReplySchema validates directory listings', () => {
  it('reads a valid browse reply with directory and file entries', () => {
    const reply = {
      resolvedPath: '/Users/alice',
      entries: [
        { name: 'projects', isDirectory: true, isSymlink: false },
        { name: 'file.txt', isDirectory: false }
      ],
      pathFlavor: 'posix'
    }
    const result = reads(serverDirectoryBrowseReplySchema, reply)
    expect(result.resolvedPath).toBe('/Users/alice')
    expect(result.pathFlavor).toBe('posix')
    expect(result.entries).toEqual([
      { name: 'projects', isDirectory: true, isSymlink: false },
      { name: 'file.txt', isDirectory: false, isSymlink: undefined }
    ])
  })

  it('reads a Windows browse reply', () => {
    const reply = {
      resolvedPath: 'C:\\Users\\alice',
      entries: [{ name: 'code', isDirectory: true }],
      pathFlavor: 'win32'
    }
    const result = reads(serverDirectoryBrowseReplySchema, reply)
    expect(result.resolvedPath).toBe('C:\\Users\\alice')
    expect(result.pathFlavor).toBe('win32')
  })

  it('refuses replies with missing required fields or unknown path flavor', () => {
    expect(refuses(serverDirectoryBrowseReplySchema, { entries: [], pathFlavor: 'posix' })).toBe(
      true
    )
    expect(
      refuses(serverDirectoryBrowseReplySchema, { resolvedPath: '/', pathFlavor: 'posix' })
    ).toBe(true)
    expect(
      refuses(serverDirectoryBrowseReplySchema, {
        resolvedPath: '/',
        entries: [],
        pathFlavor: 'bsd'
      })
    ).toBe(true)
    expect(refuses(serverDirectoryBrowseReplySchema, null)).toBe(true)
  })
})

describe('repoAddReplySchema validates project registration reply', () => {
  it('reads a valid repo add reply', () => {
    const reply = {
      repo: {
        id: 'repo-1',
        displayName: 'orca',
        path: '/code/orca',
        kind: 'git',
        badgeColor: '#123456'
      }
    }
    const result = reads(repoAddReplySchema, reply)
    expect(result.repo.id).toBe('repo-1')
    expect(result.repo.displayName).toBe('orca')
    expect(result.repo.path).toBe('/code/orca')
    expect(result.repo.kind).toBe('git')
    expect(result.repo.badgeColor).toBe('#123456')
  })

  it('refuses replies missing repo or required repo fields', () => {
    expect(refuses(repoAddReplySchema, {})).toBe(true)
    expect(refuses(repoAddReplySchema, { repo: { id: 'repo-1' } })).toBe(true)
    expect(refuses(repoAddReplySchema, { repo: null })).toBe(true)
    expect(refuses(repoAddReplySchema, null)).toBe(true)
  })
})
