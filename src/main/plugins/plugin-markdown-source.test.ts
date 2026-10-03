import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWorkspaceLaunchScope } from '../runtime/runtime-legacy-worker-terminal-recovery-types'
import {
  resolvePluginMarkdownSource,
  type PluginMarkdownSourceAuthority
} from './plugin-markdown-source'
import { validatePluginMarkdownReferences } from './plugin-markdown-references'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(folder = false) {
  const root = await mkdtemp(join(tmpdir(), 'orca-markdown-source-'))
  roots.push(root)
  const workspace = join(root, 'notes')
  await mkdir(workspace)
  const documentPath = join(workspace, 'a.md')
  await writeFile(documentPath, '# A')
  const scope: TerminalWorkspaceLaunchScope = {
    id: folder ? 'folder:notes' : 'repo::notes',
    path: workspace,
    connectionId: null,
    executionHostId: 'local',
    repo: folder
      ? null
      : { id: 'repo', path: workspace, displayName: 'Notes', badgeColor: '', addedAt: 0 },
    folderWorkspace: folder
      ? {
          id: 'notes',
          projectGroupId: 'group',
          name: 'Notes',
          folderPath: workspace,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      : null
  }
  const authority: PluginMarkdownSourceAuthority = {
    getRuntimeId: () => 'runtime',
    showTerminalWorkspaceLaunchScope: vi.fn(async () => scope)
  }
  const request = {
    fileId: 'exact-file',
    worktreeId: scope.id,
    documentPath,
    runtimeEnvironmentId: null
  }
  return { root, workspace, documentPath, scope, authority, request }
}

describe('Markdown source authorization', () => {
  it.each(['md', 'mdx', 'markdown'])('supports the %s source extension', async (extension) => {
    const f = await fixture()
    const documentPath = join(f.workspace, `note.${extension}`)
    await writeFile(documentPath, '# Note')
    expect(
      await resolvePluginMarkdownSource(f.authority, { ...f.request, documentPath })
    ).toMatchObject({ status: 'resolved' })
    expect(
      await resolvePluginMarkdownSource(f.authority, {
        ...f.request,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ).toMatchObject({ status: 'unavailable' })
  })

  it.each([false, true])(
    'resolves exact local source for folder=%s without focus',
    async (folder) => {
      const f = await fixture(folder)
      expect(await resolvePluginMarkdownSource(f.authority, f.request)).toMatchObject({
        status: 'resolved',
        source: { fileId: 'exact-file', runtimeId: 'runtime', worktreeId: f.scope.id }
      })
      expect(f.authority.showTerminalWorkspaceLaunchScope).toHaveBeenCalledWith(
        `id:${f.scope.id}`,
        { materializePushTarget: false }
      )
    }
  )

  it('refuses foreign environment, unsupported WSL, floating, absent and non-Markdown documents', async () => {
    const f = await fixture()
    const bad = [
      { ...f.request, runtimeEnvironmentId: 'remote' },
      { ...f.request, documentPath: '\\\\wsl.localhost\\Example\\a.md' },
      { ...f.request, documentPath: 'relative.md' },
      { ...f.request, documentPath: join(f.workspace, 'missing.md') },
      { ...f.request, documentPath: f.workspace },
      { ...f.request, documentPath: join(f.workspace, 'a.js') }
    ]
    for (const request of bad) {
      expect(await resolvePluginMarkdownSource(f.authority, request)).toEqual({
        status: 'unavailable',
        reason: 'unsupported-context'
      })
    }
    expect(await resolvePluginMarkdownSource(null, f.request)).toMatchObject({
      status: 'unavailable'
    })
  })

  it('refuses mismatched IDs and remote execution owners even for locally existing paths', async () => {
    const f = await fixture()
    expect(
      await resolvePluginMarkdownSource(f.authority, { ...f.request, worktreeId: 'other' })
    ).toMatchObject({ status: 'unavailable' })
    f.scope.connectionId = 'remote'
    expect(await resolvePluginMarkdownSource(f.authority, f.request)).toMatchObject({
      status: 'unavailable'
    })
    f.scope.connectionId = null
    f.scope.executionHostId = 'runtime:other'
    expect(await resolvePluginMarkdownSource(f.authority, f.request)).toMatchObject({
      status: 'unavailable'
    })
    f.scope.executionHostId = 'local'
    if (!f.scope.repo) {
      throw new Error('fixture needs repo')
    }
    f.scope.repo.executionHostId = 'runtime:other'
    expect(await resolvePluginMarkdownSource(f.authority, f.request)).toMatchObject({
      status: 'unavailable'
    })
  })

  it('rejects document traversal and symlink escape; verifies reference parents for missing targets', async () => {
    const f = await fixture(true)
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    const outsideDocument = join(outside, 'outside.md')
    await writeFile(outsideDocument, '# Outside')
    await symlink(
      outside,
      join(f.workspace, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(
      await resolvePluginMarkdownSource(f.authority, {
        ...f.request,
        documentPath: outsideDocument
      })
    ).toMatchObject({ status: 'unavailable' })
    expect(
      await resolvePluginMarkdownSource(f.authority, {
        ...f.request,
        documentPath: join(f.workspace, 'escape', 'outside.md')
      })
    ).toMatchObject({ status: 'unavailable' })
    const resolved = await resolvePluginMarkdownSource(f.authority, f.request)
    if (resolved.status !== 'resolved') {
      throw new Error('expected resolved fixture')
    }
    expect(
      await validatePluginMarkdownReferences(resolved.source, {
        kind: 'list',
        items: [{ text: 'Missing', reference: { path: 'missing/a.md', base: 'workspace' } }]
      })
    ).toBe(true)
    expect(
      await validatePluginMarkdownReferences(resolved.source, {
        kind: 'list',
        items: [
          { text: 'Outside', reference: { path: 'escape/missing/deep.md', base: 'workspace' } }
        ]
      })
    ).toBe(false)
    expect(
      await validatePluginMarkdownReferences(resolved.source, {
        kind: 'list',
        items: [{ text: 'A', reference: { path: 'a.md', base: 'document' } }]
      })
    ).toBe(true)
  })
})
