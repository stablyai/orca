/**
 * Host Markdown documents on an SSH workspace: reads and writes go through the execution host's
 * provider, never a local substitute, and a save that started on one connection never lands on a
 * replacement connection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_READ_MAX_BYTES
} from '../../shared/mobile-markdown-document'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { IFilesystemProvider } from '../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  advanceSshConnectionGeneration,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { readSshMarkdownDocument } from './host-markdown-document-reader'
import {
  readHostMarkdownTab,
  saveHostMarkdownTab,
  type HostMarkdownRuntime
} from './runtime-mobile-markdown-documents'

const TARGET = 'ssh-target-1'
const WORKTREE = 'repo-1::/srv/work'
const FILE = '/srv/work/notes.md'

function memoryProvider(
  files: Map<string, Buffer>,
  options: { ranged: boolean }
): IFilesystemProvider {
  const provider = {
    stat: vi.fn(async (path: string) => ({
      size: files.get(path)?.length ?? 0,
      type: 'file' as const,
      mtime: 1
    })),
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(path) ?? Buffer.alloc(0)
      return { content: bytes.toString('utf8'), isBinary: bytes.includes(0) }
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, Buffer.from(content))
    }),
    ...(options.ranged
      ? {
          supportsFileRangeRead: vi.fn(async () => true),
          readFileRange: vi.fn(async (path: string, position: number, length: number) => {
            expect(length).toBeLessThanOrEqual(MAX_FILE_RANGE_READ_BYTES)
            const bytes = (files.get(path) ?? Buffer.alloc(0)).subarray(position, position + length)
            return { bytes, bytesRead: bytes.length }
          })
        }
      : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host Markdown paths call only stat/readFile/readFileRange/writeFile, all implemented above.
  return provider as unknown as IFilesystemProvider
}

describe('SSH Markdown document reads', () => {
  it('reads a small file whole through the provider', async () => {
    const files = new Map([[FILE, Buffer.from('# Héllo')]])
    await expect(
      readSshMarkdownDocument(FILE, memoryProvider(files, { ranged: false }))
    ).resolves.toEqual({
      content: '# Héllo',
      byteLength: Buffer.byteLength('# Héllo'),
      truncated: false
    })
  })

  it('reads a bounded UTF-8-safe prefix of a large file with ranged reads', async () => {
    const body = Buffer.from(`${'a'.repeat(MOBILE_MARKDOWN_READ_MAX_BYTES - 1)}€more`)
    const provider = memoryProvider(new Map([[FILE, body]]), { ranged: true })

    const read = await readSshMarkdownDocument(FILE, provider)

    expect(read).toEqual({
      content: 'a'.repeat(MOBILE_MARKDOWN_READ_MAX_BYTES - 1),
      byteLength: body.length,
      truncated: true
    })
    expect(provider.readFile).not.toHaveBeenCalled()
  })

  it('answers the too-large code phones explain on a relay without ranged reads', async () => {
    const body = Buffer.alloc(MOBILE_MARKDOWN_READ_MAX_BYTES + 10, 0x61)
    await expect(
      readSshMarkdownDocument(FILE, memoryProvider(new Map([[FILE, body]]), { ranged: false }))
    ).rejects.toThrow(/^file_too_large$/)
  })

  it('refuses binary content', async () => {
    const files = new Map([[FILE, Buffer.from([0x41, 0x00])]])
    await expect(
      readSshMarkdownDocument(FILE, memoryProvider(files, { ranged: true }))
    ).rejects.toThrow('binary_file')
  })
})

function sshRuntime(
  session: WorkspaceSessionState,
  files: Map<string, Buffer>
): {
  runtime: HostMarkdownRuntime
  writes: string[]
} {
  const writes: string[] = []
  const hostId = toSshExecutionHostId(TARGET)
  const runtime: HostMarkdownRuntime = {
    notifier: null,
    getAvailableAuthoritativeWindow: () => null,
    getOwnWorkspaceSessionForWorktree: () => session,
    getWorkspaceSessionForWorktree: () => session,
    setWorkspaceSessionForWorktree: vi.fn(),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => new Set(),
    mobileSessionTabsByWorktree: new Map(),
    storeMobileSessionSnapshot: (_id, snapshot) => snapshot,
    emitMobileSessionTabsSnapshot: vi.fn(),
    getMobileSessionTabsForWorktree: vi.fn(),
    applyMobileSessionTabNavigation: vi.fn(),
    hasLiveWindowDocument: () => false,
    getHostEditorWorkspaceRoot: () => '/srv/work',
    requireStore: vi.fn(),
    getWorkspaceSessionHostIdForWorktree: () => hostId,
    resolveRuntimeFileTarget: async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Markdown paths read only the worktree id and path.
      worktree: { id: WORKTREE, path: '/srv/work' } as never,
      executionHostId: hostId
    }),
    // Why: stands in for the provider write the runtime routes to the SSH host.
    writeHostMarkdownFile: async (args) => {
      args.beforeWrite()
      writes.push(args.content)
      files.set(FILE, Buffer.from(args.content))
    }
  }
  return { runtime, writes }
}

const session: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  openFilesByWorktree: {
    [WORKTREE]: [
      { filePath: FILE, relativePath: 'notes.md', worktreeId: WORKTREE, language: 'markdown' }
    ]
  }
}

describe('SSH Markdown document saves', () => {
  afterEach(() => {
    unregisterSshFilesystemProvider(TARGET)
    resetSshConnectionGenerations()
  })

  it('reads and saves through the SSH provider with no local substitution', async () => {
    const files = new Map([[FILE, Buffer.from('remote')]])
    registerSshFilesystemProvider(TARGET, memoryProvider(files, { ranged: true }))
    const { runtime, writes } = sshRuntime(session, files)

    const read = await readHostMarkdownTab(runtime, WORKTREE, FILE)
    expect(read).toMatchObject({ content: 'remote', editable: true })

    await expect(
      saveHostMarkdownTab(runtime, WORKTREE, FILE, hashMarkdownContent('remote'), 'edited')
    ).resolves.toMatchObject({ content: 'edited', version: hashMarkdownContent('edited') })
    expect(writes).toEqual(['edited'])
  })

  it('fails when the SSH provider is unavailable instead of reading locally', async () => {
    const { runtime } = sshRuntime(session, new Map())
    await expect(readHostMarkdownTab(runtime, WORKTREE, FILE)).rejects.toThrow()
  })

  it('aborts a save whose SSH connection was replaced while it was queued', async () => {
    const files = new Map([[FILE, Buffer.from('remote')]])
    const provider = memoryProvider(files, { ranged: true })
    registerSshFilesystemProvider(TARGET, provider)
    advanceSshConnectionGeneration(TARGET)
    const { runtime, writes } = sshRuntime(session, files)
    vi.mocked(provider.stat).mockImplementationOnce(async (path: string) => {
      // Why: the connection is replaced after the save captured its expectation.
      advanceSshConnectionGeneration(TARGET)
      return { size: files.get(path)!.length, type: 'file', mtime: 1 }
    })

    await expect(
      saveHostMarkdownTab(runtime, WORKTREE, FILE, hashMarkdownContent('remote'), 'edited')
    ).rejects.toThrow('SSH connection changed; refresh and try again')
    expect(writes).toEqual([])
  })
})
