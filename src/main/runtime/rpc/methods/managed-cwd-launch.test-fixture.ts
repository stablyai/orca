import { vi } from 'vitest'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import {
  OrcaRuntimeService,
  addWorktree,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  listWorktrees,
  gitRunner
} from '../../orca-runtime-test-mocks.spec'
import { store, makeWorktreeMeta } from '../../orca-runtime-test-fixtures.spec'
import { registerLivePty } from '../../bind-first-pane.test-fixture'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { mergeWorktreeMetaForWrite } from '../../../persistence/loading-store/worktree-meta-write-normalization'

type MetadataWrite = {
  target: HostWorktreeTarget
  updates: Partial<WorktreeMeta>
  before: Pick<WorktreeMeta, 'instanceId' | 'hostId'> | undefined
  after: Pick<WorktreeMeta, 'instanceId' | 'hostId'>
  gitRows: { repoPath: string; paths: string[] }[]
  writer: string[]
}

// Real managed creation/authority/metadata; only external Git and terminal effects are substituted.
export function managedCwdLaunchFixture(
  records: AgentSessionRecordStore,
  parent: Pick<Worktree, 'id' | 'path' | 'repoId'>,
  directory: string
) {
  const childPath = join(directory, 'created-child')
  const childId = `repo-1::${childPath}`
  const repos: Repo[] = [
    ...store.getRepos(),
    ...(parent.repoId === 'repo-1'
      ? []
      : [
          {
            id: parent.repoId,
            path: parent.path,
            kind: 'folder' as const,
            displayName: 'Parent',
            badgeColor: 'blue',
            addedAt: 1
          }
        ])
  ]
  const parentGit = {
    path: parent.path,
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
  const childGit = { ...parentGit, path: childPath, branch: 'child' }
  const destination = repos.find((repo) => repo.id === 'repo-1')!
  const destinationGit =
    parent.repoId === destination.id
      ? [parentGit]
      : [{ ...parentGit, path: destination.path, isMainWorktree: true }]
  const gitRows = new Map([[destination.path, destinationGit]])
  const meta: Record<string, WorktreeMeta> = {
    ...Object.fromEntries(
      destinationGit.map((row) => [
        `${destination.id}::${row.path}`,
        makeWorktreeMeta({ instanceId: 'repo-instance', hostId: 'local' })
      ])
    ),
    [`${parent.repoId}::${parent.path}`]: makeWorktreeMeta({
      instanceId: 'root-instance',
      hostId: 'local'
    }),
    [parent.id]: makeWorktreeMeta({ instanceId: 'parent-instance', hostId: 'local' })
  }
  const lineage = new Map<string, WorktreeLineage>()
  const metadataWrites: MetadataWrite[] = []
  const save = vi.fn((target: HostWorktreeTarget, value: Partial<WorktreeMeta>) => {
    const existing = meta[target.id]
    const updated = mergeWorktreeMetaForWrite(existing, value, {
      instanceId: value.instanceId ?? existing?.instanceId ?? randomUUID(),
      hostId: target.hostId
    })
    meta[target.id] = updated
    metadataWrites.push({
      target: { ...target },
      updates: structuredClone(value),
      before: existing && { instanceId: existing.instanceId, hostId: existing.hostId },
      after: { instanceId: updated.instanceId, hostId: updated.hostId },
      gitRows: [...gitRows].map(([repoPath, rows]) => ({
        repoPath,
        paths: rows.map((row) => row.path)
      })),
      writer: new Error('fixture metadata write').stack?.split('\n').slice(1, 9) ?? []
    })
    return updated
  })
  const runtimeStore = {
    ...store,
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: save,
    getWorktreeLineage: (id: string) => lineage.get(id),
    getAllWorktreeLineage: () => Object.fromEntries(lineage),
    setWorktreeLineage: (target: HostWorktreeTarget, value: WorktreeLineage) => {
      lineage.set(target.id, value)
      return value
    }
  }
  const runtime = new OrcaRuntimeService(runtimeStore)
  vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(records)
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
    ...runtime.getClientSettings()
  })
  const create = vi.spyOn(runtime, 'createManagedWorktree')
  const start = vi.spyOn(runtime, 'createTerminal').mockImplementation(async () => {
    return {
      handle: 'term_started',
      tabId: 'started-tab',
      worktreeId: childId,
      title: 'codex',
      surface: 'background'
    }
  })
  const publish = vi.spyOn(runtime, 'publishAgentLaunchTab')
  const showRepo = vi.spyOn(runtime, 'showRepo')
  const showTerminal = vi.spyOn(runtime, 'showTerminal')
  const catalog = vi.spyOn(runtime, 'listManagedWorktrees')
  const git = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => ({
    stdout: args[0] === 'rev-parse' && args.includes('--verify') ? `${'a'.repeat(40)}\n` : '',
    stderr: ''
  }))
  computeWorktreePathMock.mockReturnValue(childPath)
  ensurePathWithinWorkspaceMock.mockReturnValue(childPath)
  vi.mocked(listWorktrees).mockImplementation(async (repoPath) => gitRows.get(repoPath) ?? [])
  vi.mocked(addWorktree).mockImplementation(async (repoPath) => {
    gitRows.set(repoPath, [...(gitRows.get(repoPath) ?? []), childGit])
    return {}
  })
  const ptyId = 'cwd-caller-pty'
  const tabId = 'cwd-caller-tab'
  const leafId = '11111111-1111-4111-8111-111111111111'
  const caller = runtime.preAllocateHandleForPty(ptyId)
  registerLivePty(runtime, ptyId, parent.id, null, { tabId, leafId })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId, worktreeId: parent.id, title: 'Codex', activeLeafId: leafId, layout: null }],
    leaves: [{ tabId, worktreeId: parent.id, leafId, paneRuntimeId: 1, ptyId, paneTitle: null }]
  })
  return {
    runtime,
    runtimeStore,
    caller,
    childId,
    create,
    start,
    publish,
    showRepo,
    showTerminal,
    catalog,
    save,
    metadataWrites,
    git,
    lineage
  }
}
