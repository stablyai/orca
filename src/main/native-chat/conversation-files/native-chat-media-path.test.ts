import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import {
  clearGrokSessionPathLookupCacheForTests,
  grokEncodedCwdDirName
} from '../../../shared/grok-session-paths'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  resolveNativeChatMediaPath,
  type NativeChatMediaPathRequest
} from './native-chat-media-path'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

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
})
