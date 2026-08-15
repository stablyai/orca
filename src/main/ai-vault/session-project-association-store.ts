import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { createNormalizedPathInsideOrEqualMatcher } from '../../shared/cross-platform-path'
import type { Project } from '../../shared/project-types'
import type { Worktree } from '../../shared/worktree/types'

type StoredAssociation = {
  agent: string
  providerSession: AgentProviderSessionMetadata
  projectId: string
  repoId: string
  worktreeId: string
  worktreePath: string
  boundAt: number
  lastSeenAt: number
}

type StoredFile = {
  version: 1
  associations: Record<string, StoredAssociation>
}

type AssociationWorktree = Pick<Worktree, 'id' | 'repoId' | 'projectId' | 'path'>

function providerSessionFor(session: AiVaultSession): AgentProviderSessionMetadata {
  if (session.providerSession) {
    return session.providerSession
  }
  return {
    key: session.agent === 'antigravity' ? 'conversation_id' : 'session_id',
    id: session.sessionId,
    ...(session.agent === 'pi' || session.agent === 'prime-agent'
      ? { transcriptPath: session.filePath }
      : {})
  }
}

function associationKey(agent: string, providerSession: AgentProviderSessionMetadata): string {
  return `${agent}\0${providerSession.key}\0${providerSession.id}`
}

function projectForWorktree(worktree: Worktree, projects: readonly Project[]): Project | null {
  if (worktree.projectId) {
    return projects.find((project) => project.id === worktree.projectId) ?? null
  }
  return projects.find((project) => project.sourceRepoIds.includes(worktree.repoId)) ?? null
}

function matchingWorktree(
  session: AiVaultSession,
  worktrees: readonly Worktree[]
): Worktree | null {
  if (!session.cwd) {
    return null
  }
  return (
    worktrees
      .filter((worktree) => createNormalizedPathInsideOrEqualMatcher(worktree.path)(session.cwd!))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null
  )
}

export class AgentSessionProjectAssociationStore {
  private loadPromise: Promise<void> | null = null
  private associations = new Map<string, StoredAssociation>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private load(): Promise<void> {
    this.loadPromise ??= this.loadFromDisk()
    return this.loadPromise
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredFile>
      if (parsed.version !== 1 || !parsed.associations) {
        return
      }
      for (const [key, value] of Object.entries(parsed.associations)) {
        if (value?.projectId && value.providerSession?.id) {
          this.associations.set(key, value)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[agent-session] project association load failed', error)
      }
    }
  }

  private record(
    agent: string,
    providerSession: AgentProviderSessionMetadata,
    worktree: AssociationWorktree,
    project: Project,
    now: number
  ): boolean {
    const key = associationKey(agent, providerSession)
    const previous = this.associations.get(key)
    const next: StoredAssociation = {
      agent,
      providerSession,
      projectId: project.id,
      repoId: worktree.repoId,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      boundAt: previous?.boundAt ?? now,
      lastSeenAt: previous?.lastSeenAt ?? now
    }
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) {
      return false
    }
    this.associations.set(key, next)
    return true
  }

  private async persist(): Promise<void> {
    const snapshot: StoredFile = {
      version: 1,
      associations: Object.fromEntries(this.associations)
    }
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
      await rename(temporary, this.filePath)
    })
    await this.writeQueue
  }

  async capture(args: {
    agent: string
    providerSession: AgentProviderSessionMetadata
    worktree: AssociationWorktree
    project: Project
  }): Promise<void> {
    await this.load()
    if (this.record(args.agent, args.providerSession, args.worktree, args.project, Date.now())) {
      await this.persist()
    }
  }

  async enrich(args: {
    result: AiVaultListResult
    projects: readonly Project[]
    worktrees: readonly Worktree[]
    hookSessions: readonly AgentStatusIpcPayload[]
  }): Promise<AiVaultListResult> {
    await this.load()
    const now = Date.now()
    let changed = false

    for (const hook of args.hookSessions) {
      if (!hook.agentType || !hook.providerSession || !hook.worktreeId) {
        continue
      }
      const worktree = args.worktrees.find((candidate) => candidate.id === hook.worktreeId)
      if (!worktree) {
        continue
      }
      const project = projectForWorktree(worktree, args.projects)
      if (!project) {
        continue
      }
      changed = this.record(hook.agentType, hook.providerSession, worktree, project, now) || changed
    }

    const sessions: AiVaultSession[] = args.result.sessions.map((session): AiVaultSession => {
      const providerSession = providerSessionFor(session)
      const liveHook = args.hookSessions.find(
        (hook) =>
          hook.agentType === session.agent &&
          hook.providerSession?.key === providerSession.key &&
          hook.providerSession.id === providerSession.id
      )
      let association = this.associations.get(associationKey(session.agent, providerSession))
      if (!association) {
        const worktree = matchingWorktree(session, args.worktrees)
        const project = worktree ? projectForWorktree(worktree, args.projects) : null
        if (worktree && project) {
          changed = this.record(session.agent, providerSession, worktree, project, now) || changed
          association = this.associations.get(associationKey(session.agent, providerSession))
        }
      }
      if (!association) {
        return { ...session, providerSession }
      }
      const project = args.projects.find((candidate) => candidate.id === association.projectId)
      const originalWorktree = args.worktrees.find(
        (candidate) =>
          candidate.id === association!.worktreeId ||
          candidate.priorWorktreeIds?.includes(association!.worktreeId)
      )
      return {
        ...session,
        providerSession,
        ...(liveHook?.terminalHandle ? { liveTerminalHandle: liveHook.terminalHandle } : {}),
        project: {
          id: association.projectId,
          repoId: association.repoId,
          displayName: project?.displayName ?? association.projectId,
          originalWorktreeId: association.worktreeId,
          originalWorktreePath: association.worktreePath,
          workspaceAvailability: originalWorktree
            ? originalWorktree.isArchived
              ? 'archived'
              : 'active'
            : 'missing'
        }
      }
    })

    if (changed) {
      await this.persist()
    }
    return { ...args.result, sessions }
  }
}
