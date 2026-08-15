import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { Project } from '../../shared/project-types'
import type { Worktree } from '../../shared/worktree/types'
import { AgentSessionProjectAssociationStore } from './session-project-association-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function session(): AiVaultSession {
  return {
    id: 'codex:session-1',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Keep this conversation',
    cwd: '/workspace/worktrees/orca/task-one',
    branch: null,
    model: null,
    filePath: '/profile/codex/session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-08-15T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [{ role: 'user', text: 'hello', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

function result(): AiVaultListResult {
  return { sessions: [session()], issues: [], scannedAt: '2026-08-15T00:00:00.000Z' }
}

describe('AgentSessionProjectAssociationStore', () => {
  it('keeps project attribution after the original worktree disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-session-project-'))
    temporaryDirectories.push(root)
    const filePath = join(root, 'associations.json')
    const project = {
      id: 'project-orca',
      displayName: 'Orca',
      badgeColor: '#000000',
      sourceRepoIds: ['repo-orca'],
      createdAt: 1,
      updatedAt: 1
    } satisfies Project
    const worktree = {
      id: 'repo-orca::/workspace/worktrees/orca/task-one',
      repoId: 'repo-orca',
      projectId: project.id,
      path: '/workspace/worktrees/orca/task-one',
      isArchived: false
    } as Worktree
    const hook = {
      agentType: 'codex',
      worktreeId: worktree.id,
      terminalHandle: 'term_live',
      providerSession: { key: 'session_id', id: 'session-1' }
    } as AgentStatusIpcPayload

    const store = new AgentSessionProjectAssociationStore(filePath)
    await store.capture({
      agent: 'codex',
      providerSession: hook.providerSession!,
      project,
      worktree
    })
    const first = await store.enrich({
      result: result(),
      projects: [project],
      worktrees: [worktree],
      hookSessions: [hook]
    })
    expect(first.sessions[0]).toMatchObject({
      liveTerminalHandle: 'term_live',
      project: { id: project.id, displayName: 'Orca', workspaceAvailability: 'active' }
    })

    const restored = await new AgentSessionProjectAssociationStore(filePath).enrich({
      result: result(),
      projects: [project],
      worktrees: [],
      hookSessions: []
    })
    expect(restored.sessions[0].project).toMatchObject({
      id: project.id,
      originalWorktreeId: worktree.id,
      workspaceAvailability: 'missing'
    })
  })
})
