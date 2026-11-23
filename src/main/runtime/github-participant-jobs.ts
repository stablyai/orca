import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { writeOwnerOnlyFileDurable } from '../filesystem/owner-only-durable-file-write'
import { withSidecarSnapshotQueue } from '../filesystem/sidecar-snapshot-file'
import type { GitHubExecutionIdentity } from '../../shared/github/execution-identity'

const text = z.string().min(1)
const identitySchema = z
  .object({
    repoId: text,
    participantId: text,
    account: z.object({ host: text, user: text }).strict()
  })
  .strict()
const binding = z.object({ key: text, workspaceId: text, identity: identitySchema }).strict()
const stateSchema = z
  .object({
    version: z.literal(1),
    sessions: z.array(binding),
    terminals: z.array(binding.extend({ tokenHash: text }))
  })
  .strict()
type State = z.infer<typeof stateSchema>
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export class GitHubParticipantJobs {
  private readonly path: string
  private state: State = { version: 1, sessions: [], terminals: [] }
  private unavailable = false
  private loaded = false
  private readonly initialization: Promise<void>
  constructor(directory: string) {
    this.path = join(directory, 'github-participant-jobs.json')
    this.initialization = withSidecarSnapshotQueue(this.path, async () => {
      try {
        this.state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
      } catch (error) {
        this.unavailable = !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      } finally {
        this.loaded = true
      }
    })
  }

  ready(): Promise<void> {
    return this.initialization
  }

  bindSession(
    key: string,
    workspaceId: string,
    identity: GitHubExecutionIdentity
  ): Promise<GitHubExecutionIdentity> {
    return this.mutate(async () => {
      const prior = this.state.sessions.find((entry) => entry.key === key)
      if (prior) {
        if (
          prior.workspaceId !== workspaceId ||
          prior.identity.repoId !== identity.repoId ||
          prior.identity.participantId !== identity.participantId
        ) {
          throw new Error('github_participant_owner_mismatch')
        }
        return structuredClone(prior.identity)
      }
      await this.save({
        ...this.state,
        sessions: [...this.state.sessions, { key, workspaceId, identity }]
      })
      return structuredClone(identity)
    })
  }

  bindTerminal(
    key: string,
    workspaceId: string,
    token: string,
    identity: GitHubExecutionIdentity
  ): Promise<void> {
    return this.mutate(async () => {
      const prior = this.state.terminals.find(
        (entry) => entry.key === key && entry.tokenHash === hash(token)
      )
      if (
        prior &&
        (prior.identity.participantId !== identity.participantId ||
          prior.identity.repoId !== identity.repoId ||
          prior.workspaceId !== workspaceId)
      ) {
        throw new Error('github_participant_owner_mismatch')
      }
      if (prior) {
        return
      }
      await this.save({
        ...this.state,
        terminals: [
          ...this.state.terminals.filter((entry) => entry.key !== key),
          { key, workspaceId, tokenHash: hash(token), identity }
        ]
      })
    })
  }

  session(key: string, workspaceId: string): GitHubExecutionIdentity | undefined {
    this.requireAvailable()
    const entry = this.state.sessions.find(
      (item) => item.key === key && item.workspaceId === workspaceId
    )
    return entry ? structuredClone(entry.identity) : undefined
  }

  terminal(key: string, workspaceId: string, token: string): GitHubExecutionIdentity | undefined {
    this.requireAvailable()
    const tokenHash = hash(token)
    const entry = this.state.terminals.find(
      (item) => item.key === key && item.workspaceId === workspaceId && item.tokenHash === tokenHash
    )
    return entry ? structuredClone(entry.identity) : undefined
  }

  private requireAvailable(): void {
    if (!this.loaded || this.unavailable) {
      throw new Error('github_participant_jobs_unavailable')
    }
  }

  private mutate<T>(change: () => Promise<T>): Promise<T> {
    return withSidecarSnapshotQueue(this.path, async () => {
      await this.ready()
      this.requireAvailable()
      return change()
    })
  }

  private async save(next: State): Promise<void> {
    const parsed = stateSchema.parse(next)
    try {
      await writeOwnerOnlyFileDurable(this.path, JSON.stringify(parsed))
      this.state = parsed
    } catch (error) {
      this.unavailable = true
      throw error
    }
  }
}

type ProfileStore = { getProfileStorageDirectory?: () => string }
const stores = new WeakMap<ProfileStore, GitHubParticipantJobs>()
export function getStoreGitHubParticipantJobs(
  store: ProfileStore
): GitHubParticipantJobs | undefined {
  const existing = stores.get(store)
  if (existing) {
    return existing
  }
  const directory = store.getProfileStorageDirectory?.()
  if (!directory) {
    return undefined
  }
  const jobs = new GitHubParticipantJobs(directory)
  stores.set(store, jobs)
  return jobs
}
