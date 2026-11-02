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
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import * as statusIdentity from '../agent-hooks/server/server-status-identity'
import { LAST_STATUS_FILE_VERSION } from '../agent-hooks/server/server-constants'
import { RuntimeTerminalPathResolver } from '../runtime/terminal/terminal-path-resolver'
import {
  resolveNativeChatMediaPath,
  type NativeChatMediaPathRequest
} from './native-chat-media-path'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

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
  vi.useRealTimers()
  vi.restoreAllMocks()
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
    providerRows: vi.fn((_tabId: string): AgentStatusIpcPayload[] => [])
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
      expect(path).toContain('%')
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
      { ...fixture.sources.providerRows('chat-tab')[0]!, connectionId: 'remote' }
    ])
    expect(await fixture.resolve()).toEqual({ kind: 'none' })
  })

  it.each([100, 1000])(
    'shares provider row construction across image requests with %i retained panes',
    async (population) => {
      const directory = await session('provider-1')
      const path = await image(directory)
      const server = new AgentHookServer()
      const leaf = '11111111-1111-4111-8111-111111111111'
      const owner = makePaneKey('chat-tab', leaf)
      const publish = (tabId: string, id: string, transcriptPath?: string) =>
        server.recordLaunchResumeIdentity({
          paneKey: makePaneKey(tabId, leaf),
          worktreeId: 'workspace-1',
          agentType: 'grok',
          providerSession: { key: 'session_id', id, transcriptPath, cwd },
          launchedAt: 0
        })
      try {
        publish('chat-tab', 'provider-1', join(directory, 'chat_history.jsonl'))
        for (let index = 1; index < population; index += 1) {
          publish(`unrelated-${index}`, `other-${index}`)
        }
        const construct = vi.spyOn(statusIdentity, 'toAgentStatusIpcPayload')
        const deps = agentHookRuntimeDeps(
          server,
          { read: () => ({ kind: 'unobserved' }) },
          () => ({})
        )
        let selectedRows = 0
        const fixture = setup()
        fixture.sources.getConversation.mockReturnValue(null)
        fixture.request.context.sessionId = 'provider-1'
        fixture.sources.providerRows.mockImplementation((tabId) => {
          const selected = deps.getAgentProviderSessionSnapshot(tabId)
          selectedRows += selected.length
          return selected
        })
        const imageCount = population / 50
        for (let index = 0; index < imageCount; index += 1) {
          expect(await fixture.resolve()).toEqual({ kind: 'matched', absolutePath: path })
        }
        expect(construct).toHaveBeenCalledTimes(population)
        expect(selectedRows).toBe(imageCount)
        expect(fixture.sources.providerRows).toHaveBeenLastCalledWith('chat-tab')

        const replacement = await session('provider-2')
        const replacementPath = await image(replacement)
        publish('chat-tab', 'provider-2', join(replacement, 'chat_history.jsonl'))
        expect(await fixture.resolve()).toEqual({ kind: 'none' })
        fixture.request.context.sessionId = 'provider-2'
        expect(await fixture.resolve()).toEqual({ kind: 'matched', absolutePath: replacementPath })
        server.dropStatusEntry(owner, { preserveResumeIdentity: false })
        expect(await fixture.resolve()).toEqual({ kind: 'none' })
      } finally {
        server.stop()
      }
    }
  )

  it('retires source projections on hydration, reset and keep-status teardown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
    class HydrationServer extends AgentHookServer {
      hydrate(path: string): void {
        this.lastStatusFilePath = path
        this.hydrateLastStatusFromDisk()
      }
    }
    const directory = await session('provider-1')
    const server = new HydrationServer()
    try {
      const paneKey = makePaneKey('chat-tab', '11111111-1111-4111-8111-111111111111')
      server.recordLaunchResumeIdentity({
        paneKey,
        worktreeId: 'workspace-1',
        agentType: 'grok',
        providerSession: {
          key: 'session_id',
          id: 'provider-1',
          cwd,
          transcriptPath: join(directory, 'chat_history.jsonl')
        },
        launchedAt: 0
      })
      const file = join(root, 'last-status.json')
      await writeFile(
        file,
        JSON.stringify({
          version: LAST_STATUS_FILE_VERSION,
          entries: Object.fromEntries(server._getStateForTests().lastStatusByPaneKey)
        })
      )
      expect(server.getProviderSessionSourceRowsForTab('chat-tab')).toHaveLength(1)
      server.stop({ keepStatus: true })
      expect(server.getProviderSessionSourceRowsForTab('chat-tab')).toEqual([])
      server.hydrate(file)
      expect(server.getProviderSessionSourceRowsForTab('chat-tab')).toHaveLength(1)
      server.dropStatusEntry(paneKey, { preserveResumeIdentity: false })
      expect(server.getProviderSessionSourceRowsForTab('chat-tab')).toEqual([])
      server.hydrate(file)
      expect(server.getProviderSessionSourceRowsForTab('chat-tab')).toHaveLength(1)
      server._resetCanonicalStatusForTests()
      expect(server.getProviderSessionSourceRowsForTab('chat-tab')).toEqual(
        server.getStatusSnapshot()
      )
    } finally {
      server.stop()
    }
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
