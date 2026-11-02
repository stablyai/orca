import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { agentSessionRecordFixture } from './agent-session-record-test-fixture'
import {
  clearGrokSessionPathLookupCacheForTests,
  grokEncodedCwdDirName
} from '../../shared/grok-session-paths'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { RuntimeTerminalPathResolver } from '../runtime/terminal/terminal-path-resolver'
import {
  resolveNativeChatMediaPath,
  type NativeChatMediaPathRequest
} from './native-chat-media-path'

let root: string
let home: string
let cwd: string
const imagePath = 'images/create-worktree-closed-field.png'

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-grok-media-')))
  home = join(root, 'account')
  cwd = join(root, 'workspace')
  await mkdir(cwd, { recursive: true })
  clearGrokSessionPathLookupCacheForTests()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  clearGrokSessionPathLookupCacheForTests()
})

async function session(id: string, parent?: string, account = home) {
  const directory = join(account, 'sessions', grokEncodedCwdDirName(cwd)!, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'chat_history.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      content: `![Create worktree closed field](${imagePath})`
    })}\n`
  )
  await writeFile(
    join(directory, 'summary.json'),
    JSON.stringify({
      info: { id, cwd },
      parent_session_id: parent ?? null
    })
  )
  return directory
}

async function image(directory: string, value = 'session image') {
  const path = join(directory, imagePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
  return path
}

function setup(ids = ['provider-1']) {
  const record = agentSessionConversationView(
    agentSessionRecordFixture({
      sessionId: 'orca-chat',
      provider: 'grok',
      location: { workspaceId: 'workspace-1' },
      accountHome: { variable: 'GROK_HOME', path: home },
      launchDirectory: cwd,
      providerHandleChain: ids.map((nativeId, index) => ({
        linkId: `link-${index}`,
        handle: { agent: 'grok', transport: 'acp', nativeId },
        origin: index === 0 ? 'adopted' : 'resumed',
        mintedAtFence: 1,
        observedAt: 0
      }))
    })
  )
  const sources = {
    getConversation: vi.fn((): typeof record | null => record),
    getSessionTabId: vi.fn(() => 'chat-tab'),
    providerRows: vi.fn((): AgentStatusIpcPayload[] => [])
  }
  const request: NativeChatMediaPathRequest = {
    worktreeId: 'workspace-1',
    worktreePath: cwd,
    executionHostId: 'local',
    pathText: imagePath,
    context: { tabId: 'chat-tab', sessionId: 'orca-chat' }
  }
  return { record, sources, request, resolve: () => resolveNativeChatMediaPath(request, sources) }
}

describe('Grok session-owned media resolution', () => {
  it.each([imagePath, `./${imagePath}`])(
    'recovers session screenshots with literal percent path bytes: %s',
    async (relativePath) => {
      const directory = await session('provider-1')
      const path = await image(directory)
      await image(cwd, 'different workspace image')
      const fixture = setup()
      fixture.request.pathText = relativePath
      const result = await fixture.resolve()
      expect(result).toEqual({ kind: 'matched', absolutePath: path })
      expect(path).toContain('%2F')
      expect(await readFile(path, 'utf8')).toBe('session image')
    }
  )

  it('uses inherited images from summary-attested fork ancestry and deduplicates chain entries', async () => {
    const parent = await session('parent')
    await session('child', 'parent')
    const path = await image(parent)
    expect(await setup(['parent', 'child', 'child']).resolve()).toEqual({
      kind: 'matched',
      absolutePath: path
    })
    expect(await setup(['child']).resolve()).toEqual({ kind: 'matched', absolutePath: path })
  })

  it('reports ambiguous inherited media even when a workspace file has the same name', async () => {
    await image(await session('parent'))
    await image(await session('child', 'parent'))
    await image(cwd, 'workspace')
    expect(await setup(['child']).resolve()).toEqual({ kind: 'ambiguous' })
  })

  it('retains workspace fallback for absent session media and ordinary workspace paths', async () => {
    await session('provider-1')
    await image(cwd)
    const fixture = setup()
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    fixture.request.pathText = 'docs/logo.png'
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    expect(fixture.sources.getConversation).toHaveBeenCalledTimes(1)
  })

  it('does not select another account, tab, host, workspace or WSL session', async () => {
    await image(await session('provider-1', undefined, join(root, 'other-account')))
    const fixture = setup()
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    await image(await session('provider-1'))
    fixture.request.context.tabId = 'foreign-tab'
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    fixture.request.context.tabId = 'chat-tab'
    fixture.request.worktreeId = 'other-workspace'
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    fixture.request.worktreeId = 'workspace-1'
    fixture.request.executionHostId = 'ssh:other'
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    fixture.request.executionHostId = 'local'
    fixture.record.location.wslDistro = 'Ubuntu'
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
  })

  it('rejects traversal and escaped session media symlinks', async () => {
    const directory = await session('provider-1')
    const fixture = setup()
    fixture.request.pathText = 'images/../../secret.png'
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
    fixture.request.pathText = imagePath
    await mkdir(join(directory, 'images'))
    const outside = await image(cwd)
    await symlink(outside, join(directory, imagePath))
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
  })

  it('uses an attested terminal provider row without a structured conversation', async () => {
    const directory = await session('provider-1')
    const path = await image(directory)
    const fixture = setup()
    fixture.sources.getConversation.mockReturnValue(null)
    fixture.request.context.sessionId = 'provider-1'
    fixture.sources.providerRows.mockReturnValue([
      {
        state: 'done',
        prompt: '',
        receivedAt: 0,
        stateStartedAt: 0,
        agentType: 'grok',
        tabId: 'chat-tab',
        paneKey: 'unused',
        worktreeId: 'workspace-1',
        connectionId: null,
        providerSession: {
          key: 'session_id',
          id: 'provider-1',
          transcriptPath: join(directory, 'chat_history.jsonl'),
          cwd
        }
      }
    ])
    expect(await fixture.resolve()).toEqual({ kind: 'matched', absolutePath: path })
    fixture.sources.providerRows.mockReturnValue([
      { ...fixture.sources.providerRows()[0]!, connectionId: 'remote' }
    ])
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
  })
})

describe('terminal path source selection', () => {
  it('uses the chosen media path and preserves an unresolved ambiguity without workspace fallback', async () => {
    const path = await image(await session('provider-1'))
    const fixture = setup()
    const grant = vi.fn(async ({ absolutePath }: { absolutePath: string }) => ({
      worktree: 'workspace-1',
      absolutePath,
      relativePath: null,
      exists: true,
      isDirectory: false
    }))
    const selected = vi.fn(fixture.resolve)
    const resolver = new RuntimeTerminalPathResolver(
      {
        requireStore:
          vi.fn<ConstructorParameters<typeof RuntimeTerminalPathResolver>[0]['requireStore']>(),
        resolveRuntimeFileTarget: vi.fn(async () => ({
          worktree: {
            id: 'workspace-1',
            repoId: 'repo-1',
            path: cwd,
            head: '',
            branch: '',
            isBare: false,
            isMainWorktree: true,
            displayName: 'workspace',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0,
            git: { path: cwd, head: '', branch: '', isBare: false, isMainWorktree: true }
          },
          executionHostId: 'local' as const
        })),
        resolveNativeChatMediaPath: selected
      },
      { resolveAbsoluteFileGrant: grant }
    )
    const resolve = () =>
      resolver.resolveTerminalPath(
        'id:workspace-1',
        imagePath,
        null,
        'client-1',
        null,
        false,
        fixture.request.context
      )
    expect(await resolve()).toMatchObject({ absolutePath: path, exists: true })
    expect(grant).toHaveBeenCalledWith({
      worktreeId: 'workspace-1',
      absolutePath: path,
      clientId: 'client-1'
    })
    grant.mockClear()
    selected.mockResolvedValue({ kind: 'ambiguous' })
    expect(await resolve()).toMatchObject({ absolutePath: null, relativePath: null, exists: false })
    expect(grant).not.toHaveBeenCalled()
  })
})
