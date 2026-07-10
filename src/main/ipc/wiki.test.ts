import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, a: unknown) => unknown) => handlers.set(channel, fn)
  }
}))
// Why: the prompt builder imports electron `app`; stub the template reader import path instead.
const buildWikiGenerationPrompt = vi.fn(async (_input: unknown) => 'PROMPT')
vi.mock('../wiki/wiki-generation-prompt', () => ({
  buildWikiGenerationPrompt: (input: unknown) => buildWikiGenerationPrompt(input),
  readWikiTemplateFile: async () => ''
}))

const getSshFilesystemProvider = vi.fn()
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: (connectionId: string) => getSshFilesystemProvider(connectionId)
}))

import { registerWikiHandlers } from './wiki'
import type { WikiGenerationStatus } from '../wiki/wiki-generation-service'

let root: string
beforeEach(async () => {
  handlers.clear()
  buildWikiGenerationPrompt.mockClear()
  root = await mkdtemp(join(tmpdir(), 'wiki-ipc-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function register(overrides: Partial<Parameters<typeof registerWikiHandlers>[0]> = {}) {
  const generation = {
    start: vi.fn(() => ({ ok: true as const })),
    getStatus: vi.fn((): WikiGenerationStatus | null => null),
    cancel: vi.fn()
  }
  registerWikiHandlers({
    getWorktree: () => ({ path: root, repoName: 'my-repo' }),
    getSettings: () => ({
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      sourceControlAi: undefined
    }),
    generation,
    ...overrides
  })
  return { generation }
}

describe('wiki:read', () => {
  it('returns hasWiki:false when empty', async () => {
    register()
    const result = await handlers.get('wiki:read')!({}, { worktreeId: 'w1' })
    expect(result).toEqual({ hasWiki: false })
  })
  it('returns the root note content', async () => {
    await mkdir(join(root, '.wiki'), { recursive: true })
    await writeFile(join(root, '.wiki', 'Home.md'), '# Home', 'utf8')
    register()
    const result = await handlers.get('wiki:read')!({}, { worktreeId: 'w1' })
    expect(result).toMatchObject({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Home.md', content: '# Home' }
    })
  })

  it('reads over SSH when the worktree has a connectionId', async () => {
    getSshFilesystemProvider.mockReturnValue({
      listFiles: async () => ['Home.md'],
      realpath: async (p: string) => p,
      stat: async () => ({ size: 10, type: 'file', mtime: 0 }),
      readFile: async () => ({ content: '# Remote Home', isBinary: false })
    })
    register({
      getWorktree: () => ({ path: '/remote/repo', repoName: 'my-repo', connectionId: 'ssh-1' })
    })
    const result = await handlers.get('wiki:read')!({}, { worktreeId: 'w1' })
    expect(getSshFilesystemProvider).toHaveBeenCalledWith('ssh-1')
    expect(result).toMatchObject({
      hasWiki: true,
      rootRelativePath: 'Home.md',
      note: { relativePath: 'Home.md', content: '# Remote Home' }
    })
  })

  it('returns hasWiki:false when the SSH provider is unavailable', async () => {
    getSshFilesystemProvider.mockReturnValue(undefined)
    register({
      getWorktree: () => ({ path: '/remote/repo', repoName: 'my-repo', connectionId: 'ssh-1' })
    })
    const result = await handlers.get('wiki:read')!({}, { worktreeId: 'w1' })
    expect(result).toEqual({ hasWiki: false })
  })
})

describe('wiki:generate', () => {
  it('starts generation for the resolved agent with the built prompt', async () => {
    const { generation } = register()
    const result = await handlers.get('wiki:generate')!({}, { worktreeId: 'w1' })
    expect(result).toEqual({ ok: true })
    expect(generation.start).toHaveBeenCalledWith({
      worktreeId: 'w1',
      cwd: root,
      agent: 'claude',
      prompt: 'PROMPT'
    })
  })
  it('errors when no agent configured', async () => {
    register({
      getSettings: () => ({
        defaultTuiAgent: null,
        disabledTuiAgents: [],
        sourceControlAi: undefined
      })
    })
    const result = await handlers.get('wiki:generate')!({}, { worktreeId: 'w1' })
    expect(result).toMatchObject({ ok: false })
  })
  it('forwards the addClaudeMdInstruction flag to the prompt builder', async () => {
    register()
    await handlers.get('wiki:generate')!({}, { worktreeId: 'w1', addClaudeMdInstruction: true })
    expect(buildWikiGenerationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ addClaudeMdInstruction: true })
    )
  })
  it('defaults addClaudeMdInstruction to false when omitted', async () => {
    register()
    await handlers.get('wiki:generate')!({}, { worktreeId: 'w1' })
    expect(buildWikiGenerationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ addClaudeMdInstruction: false })
    )
  })
  it('rejects SSH worktrees without calling generation.start', async () => {
    const { generation } = register({
      getWorktree: () => ({ path: '/remote/repo', repoName: 'my-repo', connectionId: 'ssh-1' })
    })
    const result = await handlers.get('wiki:generate')!({}, { worktreeId: 'w1' })
    expect(result).toEqual({
      ok: false,
      error: 'Background wiki generation is not available for SSH worktrees yet.'
    })
    expect(generation.start).not.toHaveBeenCalled()
  })
})

describe('wiki:generationStatus', () => {
  it('returns what generation.getStatus returns', async () => {
    const status = { running: true, output: 'log' }
    const { generation } = register()
    generation.getStatus.mockReturnValue(status)
    const result = await handlers.get('wiki:generationStatus')!({}, { worktreeId: 'w1' })
    expect(generation.getStatus).toHaveBeenCalledWith('w1')
    expect(result).toBe(status)
  })
})

describe('wiki:cancelGeneration', () => {
  it('cancels the generation and returns ok:true', async () => {
    const { generation } = register()
    const result = await handlers.get('wiki:cancelGeneration')!({}, { worktreeId: 'w1' })
    expect(generation.cancel).toHaveBeenCalledWith('w1')
    expect(result).toEqual({ ok: true })
  })
})
