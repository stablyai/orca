import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, realpath, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  verifiedWorkspaceConversation,
  assertWorkspaceConversationScope
} from './workspace-conversation-source'

const sessionId = '00000000-0000-4000-8000-000000000001'
let root: string
let workspace: string
let sourceHome: string
let targetHome: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-workspace-continuation-')))
  workspace = join(root, 'workspace')
  sourceHome = join(root, 'source')
  targetHome = join(root, 'target')
  await Promise.all([workspace, sourceHome, targetHome].map((path) => mkdir(path)))
  await writeFile(join(sourceHome, 'auth.json'), 'source-login')
  await writeFile(join(targetHome, 'auth.json'), 'target-login')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function transcript(provider: 'claude' | 'codex', cwd = workspace) {
  const filePath =
    provider === 'codex'
      ? join(
          sourceHome,
          'sessions',
          '2026',
          '11',
          '17',
          `rollout-2026-11-17T10-00-00-${sessionId}.jsonl`
        )
      : join(sourceHome, 'projects', 'workspace', `${sessionId}.jsonl`)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(
    filePath,
    `${JSON.stringify(
      provider === 'codex'
        ? { type: 'session_meta', payload: { id: sessionId, cwd } }
        : { type: 'user', cwd, sessionId, message: { role: 'user', content: 'Continue my work' } }
    )}\n`
  )
  return {
    agent: provider,
    filePath,
    codexHome: sourceHome,
    sessionId,
    workspaceId: 'folder:workspace',
    executionHostId: 'local' as const
  }
}

it.each(['claude', 'codex'] as const)(
  'continues a %s transcript through a linked history directory',
  async (provider) => {
    const args = await transcript(provider)
    const alias = join(root, 'linked-account')
    await mkdir(alias)
    const surface = provider === 'codex' ? 'sessions' : 'projects'
    await symlink(
      join(sourceHome, surface),
      join(alias, surface),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const verified = await verifiedWorkspaceConversation({
      provider,
      sessionId,
      filePath: args.filePath,
      roots: [join(alias, surface)]
    })
    expect(verified.sourceHome).toBe(alias)
    expect(await readFile(verified.filePath, 'utf8')).toContain(
      provider === 'codex' ? 'session_meta' : 'Continue my work'
    )
  }
)

it('refuses a conversation from another workspace', async () => {
  const other = join(root, 'other')
  await mkdir(other)
  await expect(assertWorkspaceConversationScope(other, workspace)).rejects.toThrow(
    'another workspace'
  )
})

it('refuses unknown homes and mismatched session identities', async () => {
  const args = await transcript('codex')
  const verify = (filePath: string, id = sessionId) =>
    verifiedWorkspaceConversation({
      provider: 'codex',
      filePath,
      sessionId: id,
      roots: [join(sourceHome, 'sessions')]
    })
  await expect(verify(args.filePath, 'different-id')).rejects.toThrow('identity')
  const outside = join(root, 'outside.jsonl')
  await writeFile(outside, '{}')
  await expect(verify(outside)).rejects.toThrow('outside')
  await expect(verify(args.filePath, '..')).rejects.toThrow('filename segment')
})
