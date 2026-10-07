import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'
import { deriveCloneRepoNameFromUrl } from '../../src/main/git/repo-clone-path'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown) => RpcResponse
type ErrorResponse = (id: string, code: string, message: string) => RpcResponse

const CAPABILITY = 'repo.add-project-ssh-mobile.v1'
const TARGETS = [
  {
    id: 'ssh-linux',
    label: 'SSH Linux fixture',
    connected: true,
    connectionStatus: 'connected',
    remotePlatform: 'linux'
  },
  {
    id: 'ssh-windows',
    label: 'SSH Windows fixture',
    connected: true,
    connectionStatus: 'connected',
    remotePlatform: 'win32'
  },
  {
    id: 'ssh-offline',
    label: 'Offline target fixture',
    connected: false,
    connectionStatus: 'error',
    remotePlatform: 'linux'
  }
] as const

const LINUX_ROOT = '/srv/ssh-linux'
const WINDOWS_ROOT = 'C:\\Users\\orca'
const LINUX_NAMES = Array.from(
  { length: 40 },
  (_, index) => `linux-folder-${String(index + 1).padStart(2, '0')}`
)
const WINDOWS_NAMES = Array.from(
  { length: 40 },
  (_, index) => `win-folder-${String(index + 1).padStart(2, '0')}`
)
const repos: Array<Record<string, unknown>> = []
const worktrees: Array<Record<string, unknown>> = []

export const MOCK_REPO_ADD_PROJECT_CAPABILITY = CAPABILITY

export function mockSshTargetSummaries() {
  return TARGETS.map((target) => ({ ...target }))
}

export function mockRepoProjectCapability(): string {
  return CAPABILITY
}

function targetFor(value: unknown) {
  return TARGETS.find((target) => target.id === value) ?? null
}

function hostId(connectionId: string | null): string {
  return connectionId ? `ssh:${encodeURIComponent(connectionId)}` : 'local'
}

function repoFor(path: string, displayName: string, connectionId: string | null, kind: string) {
  const id = `ssh-project-${repos.length + 1}`
  const repo = {
    id,
    path,
    displayName,
    name: displayName,
    kind,
    connectionId,
    executionHostId: hostId(connectionId),
    badgeColor: '#38bdf8'
  }
  repos.unshift(repo)
  worktrees.unshift({
    worktreeId: `${id}::${path}`,
    repoId: id,
    repo: displayName,
    path,
    branch: 'main',
    displayName,
    hostId: hostId(connectionId),
    isActive: true,
    isMainWorktree: true,
    isArchived: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    workspaceStatus: 'in-progress',
    sortOrder: Date.now(),
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    hasHostSidebarActivity: false,
    lastOutputAt: null,
    preview: '$ git status',
    status: 'active',
    agents: []
  })
  return repo
}

function browse(path: string, connectionId: string | null) {
  const target = targetFor(connectionId)
  if (!target) {
    return {
      resolvedPath: '/Users/orca',
      pathFlavor: 'posix',
      entries: [{ name: 'local-project', isDirectory: true, isSymlink: false }]
    }
  }
  if (target.id === 'ssh-windows') {
    const resolvedPath = path === '~' || path === '/' ? WINDOWS_ROOT : path
    return {
      resolvedPath,
      pathFlavor: 'windows',
      entries: WINDOWS_NAMES.map((name) => ({ name, isDirectory: true, isSymlink: false }))
    }
  }
  const resolvedPath = path === '~' || path === '/' ? LINUX_ROOT : path
  return {
    resolvedPath,
    pathFlavor: 'posix',
    entries: LINUX_NAMES.map((name) => ({ name, isDirectory: true, isSymlink: false }))
  }
}

export function handleMockRepoProjectRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success,
  error: ErrorResponse
): boolean {
  if (request.method === 'ssh.listTargetSummaries') {
    respond(success(request.id, { targets: mockSshTargetSummaries() }))
    return true
  }
  if (request.method === 'files.browseServerDir') {
    const connectionId =
      typeof request.params?.sshConnectionId === 'string' ? request.params.sshConnectionId : null
    const target = targetFor(connectionId)
    if (connectionId && !target) {
      respond(error(request.id, 'invalid_params', 'Unknown SSH target'))
    } else if (target?.id === 'ssh-offline') {
      respond(error(request.id, 'ssh_unavailable', 'SSH target is offline'))
    } else {
      respond(success(request.id, browse(String(request.params?.path ?? '~'), connectionId)))
    }
    return true
  }
  if (
    request.method !== 'repo.add' &&
    request.method !== 'repo.create' &&
    request.method !== 'repo.clone'
  ) {
    return false
  }
  const connectionId =
    typeof request.params?.sshConnectionId === 'string' ? request.params.sshConnectionId : null
  const target = targetFor(connectionId)
  if (connectionId && !target) {
    respond(error(request.id, 'invalid_params', 'Unknown SSH target'))
    return true
  }
  if (target?.id === 'ssh-offline') {
    respond(error(request.id, 'ssh_unavailable', 'SSH target is offline'))
    return true
  }
  if (request.method === 'repo.add') {
    const path = String(request.params?.path ?? '')
    const kind = String(request.params?.kind ?? 'git')
    if (kind === 'git' && path.includes('folder')) {
      respond(error(request.id, 'invalid_repository', 'Not a valid git repository'))
      return true
    }
    const name = path.split(/[\\/]/).findLast(Boolean) ?? 'added-project'
    respond(success(request.id, { repo: repoFor(path, name, connectionId, kind) }))
    return true
  }
  if (request.method === 'repo.create') {
    const name = String(request.params?.name ?? 'created-project')
    const parent = String(
      request.params?.parentPath ?? (connectionId === 'ssh-windows' ? WINDOWS_ROOT : LINUX_ROOT)
    )
    const separator = connectionId === 'ssh-windows' ? '\\' : '/'
    const path = `${parent.replace(/[\\/]$/, '')}${separator}${name}`
    respond(success(request.id, { repo: repoFor(path, name, connectionId, 'git') }))
    return true
  }
  const url = String(request.params?.url ?? 'synthetic://fixture/repo')
  const destination = String(
    request.params?.destination ?? (connectionId === 'ssh-windows' ? WINDOWS_ROOT : LINUX_ROOT)
  )
  let name: string
  try {
    name = deriveCloneRepoNameFromUrl(url)
  } catch (cause) {
    respond(
      error(
        request.id,
        'invalid_params',
        cause instanceof Error ? cause.message : 'Invalid repository URL'
      )
    )
    return true
  }
  const separator = connectionId === 'ssh-windows' ? '\\' : '/'
  const clonePath = `${destination.replace(/[\\/]$/, '')}${separator}${name}`
  respond(
    success(request.id, { repo: repoFor(clonePath, name, connectionId, 'git'), sourceUrl: url })
  )
  return true
}

export function mockProjectRepos() {
  return repos
}

export function mockProjectWorktrees() {
  return worktrees
}
