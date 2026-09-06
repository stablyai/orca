import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import type { NewWorkspaceRepository } from '../worktree/host-workspace-creation-operations'

declare const hostWorkspaceIdBrand: unique symbol
declare const hostRepoIdBrand: unique symbol

/** Host-side identifiers the authority mints from an opaque page handle. Branding keeps a page
 * handle from being passed back in as if it were already resolved. */
export type MobileWebHostWorkspaceId = string & { readonly [hostWorkspaceIdBrand]: true }
export type MobileWebHostRepoId = string & { readonly [hostRepoIdBrand]: true }

/** A value the host itself reported as a host identifier, so it never came from the page. Every
 * use is a boundary annotation, not a conversion of a page handle. */
export function mobileWebHostWorkspaceIdFromHost(value: string): MobileWebHostWorkspaceId {
  return value as MobileWebHostWorkspaceId
}

export function mobileWebHostRepoIdFromHost(value: string): MobileWebHostRepoId {
  return value as MobileWebHostRepoId
}

export type MobileWebHostWorkspaceBinding = {
  workspaceId: string
  repoId: string
}

export class MobileWebWorkspaceAuthority {
  private readonly pageWorkspaceIdByHostId = new Map<string, string>()
  private readonly hostWorkspaceIdByPageId = new Map<string, string>()
  private hostRepoIdByHostWorkspaceId = new Map<string, string>()
  private readonly pageRepoIdByHostId = new Map<string, string>()
  private readonly hostRepoIdByPageId = new Map<string, string>()
  private catalogRepoIds = new Set<string>()
  private readonly hostConnectionIdByPageRepoId = new Map<string, string>()
  private readonly pageProjectIdByHostId = new Map<string, string>()
  private readonly pageExecutionHostIdByHostId = new Map<string, ExecutionHostId>()
  private nextHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  synchronize(bindings: readonly MobileWebHostWorkspaceBinding[]): void {
    const workspaceIds = new Set(bindings.map((binding) => binding.workspaceId))
    for (const hostWorkspaceId of this.pageWorkspaceIdByHostId.keys()) {
      if (!workspaceIds.has(hostWorkspaceId)) {
        const pageWorkspaceId = this.pageWorkspaceIdByHostId.get(hostWorkspaceId)
        this.pageWorkspaceIdByHostId.delete(hostWorkspaceId)
        if (pageWorkspaceId) {
          this.hostWorkspaceIdByPageId.delete(pageWorkspaceId)
        }
      }
    }
    this.hostRepoIdByHostWorkspaceId = new Map(
      bindings.map((binding) => [binding.workspaceId, binding.repoId])
    )
    for (const binding of bindings) {
      this.rememberWorkspace(binding.workspaceId)
      this.rememberRepo(binding.repoId)
    }
    this.revokeUnreferencedRepos()
  }

  pageWorkspaceId(hostWorkspaceId: string): string {
    const pageWorkspaceId = this.pageWorkspaceIdByHostId.get(hostWorkspaceId)
    if (!pageWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return pageWorkspaceId
  }

  pageRepoId(hostRepoId: string): string {
    const pageRepoId = this.pageRepoIdByHostId.get(hostRepoId)
    if (!pageRepoId) {
      throw new MobileWebBrokerError('not_found')
    }
    return pageRepoId
  }

  hostRepoId(pageRepoId: string): MobileWebHostRepoId {
    const hostRepoId = this.hostRepoIdByPageId.get(pageRepoId)
    if (!hostRepoId) {
      throw new MobileWebBrokerError('not_found')
    }
    return hostRepoId as MobileWebHostRepoId
  }

  assertHostRepoBinding(pageRepoId: string, expectedHostRepoId: MobileWebHostRepoId): void {
    if (this.hostRepoId(pageRepoId) !== expectedHostRepoId) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  synchronizeRepositories(hostRepoIds: readonly string[]): void {
    this.catalogRepoIds = new Set(hostRepoIds)
    hostRepoIds.forEach((hostRepoId) => this.rememberRepo(hostRepoId))
    this.revokeUnreferencedRepos()
  }

  synchronizeCreationRepositories(repositories: readonly NewWorkspaceRepository[]): void {
    this.synchronizeRepositories(repositories.map((repo) => repo.id))
    this.hostConnectionIdByPageRepoId.clear()
    for (const repo of repositories) {
      if (repo.connectionId) {
        this.hostConnectionIdByPageRepoId.set(this.pageRepoId(repo.id), repo.connectionId)
      }
      this.rememberProject(getProjectIdentityKey(repo))
      this.rememberExecutionHost(getRepoExecutionHostId(repo))
    }
  }

  pageProjectId(hostProjectId: string): string {
    const pageProjectId = this.pageProjectIdByHostId.get(hostProjectId)
    if (!pageProjectId) {
      throw new MobileWebBrokerError('not_found')
    }
    return pageProjectId
  }

  pageExecutionHostId(hostExecutionHostId: ExecutionHostId): ExecutionHostId {
    const pageExecutionHostId = this.pageExecutionHostIdByHostId.get(hostExecutionHostId)
    if (!pageExecutionHostId) {
      throw new MobileWebBrokerError('not_found')
    }
    return pageExecutionHostId
  }

  hostConnectionId(pageRepoId: string): string {
    const connectionId = this.hostConnectionIdByPageRepoId.get(pageRepoId)
    if (!connectionId) {
      throw new MobileWebBrokerError('not_found')
    }
    return connectionId
  }

  hostWorkspaceId(pageWorkspaceId: string): MobileWebHostWorkspaceId {
    const hostWorkspaceId = this.hostWorkspaceIdByPageId.get(pageWorkspaceId)
    if (!hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return hostWorkspaceId as MobileWebHostWorkspaceId
  }

  assertHostWorkspaceBinding(
    pageWorkspaceId: string,
    expectedHostWorkspaceId: MobileWebHostWorkspaceId
  ): void {
    if (this.hostWorkspaceId(pageWorkspaceId) !== expectedHostWorkspaceId) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  registerWorkspace(hostWorkspaceId: string, hostRepoId: string): string {
    this.rememberWorkspace(hostWorkspaceId)
    this.hostRepoIdByHostWorkspaceId.set(hostWorkspaceId, hostRepoId)
    this.rememberRepo(hostRepoId)
    return this.pageWorkspaceId(hostWorkspaceId)
  }

  clear(): void {
    this.pageWorkspaceIdByHostId.clear()
    this.hostWorkspaceIdByPageId.clear()
    this.hostRepoIdByHostWorkspaceId.clear()
    this.pageRepoIdByHostId.clear()
    this.hostRepoIdByPageId.clear()
    this.catalogRepoIds.clear()
    this.hostConnectionIdByPageRepoId.clear()
    this.pageProjectIdByHostId.clear()
    this.pageExecutionHostIdByHostId.clear()
  }

  private rememberWorkspace(hostWorkspaceId: string): void {
    if (this.pageWorkspaceIdByHostId.has(hostWorkspaceId)) {
      return
    }
    const pageWorkspaceId = this.createHandle('workspace')
    this.pageWorkspaceIdByHostId.set(hostWorkspaceId, pageWorkspaceId)
    this.hostWorkspaceIdByPageId.set(pageWorkspaceId, hostWorkspaceId)
  }

  private rememberRepo(hostRepoId: string): void {
    if (!this.pageRepoIdByHostId.has(hostRepoId)) {
      const pageRepoId = this.createHandle('repo')
      this.pageRepoIdByHostId.set(hostRepoId, pageRepoId)
      this.hostRepoIdByPageId.set(pageRepoId, hostRepoId)
    }
  }

  private revokeUnreferencedRepos(): void {
    const workspaceRepoIds = new Set(this.hostRepoIdByHostWorkspaceId.values())
    for (const [hostRepoId, pageRepoId] of this.pageRepoIdByHostId) {
      if (workspaceRepoIds.has(hostRepoId) || this.catalogRepoIds.has(hostRepoId)) {
        continue
      }
      this.pageRepoIdByHostId.delete(hostRepoId)
      this.hostRepoIdByPageId.delete(pageRepoId)
      this.hostConnectionIdByPageRepoId.delete(pageRepoId)
    }
  }

  private rememberProject(hostProjectId: string): void {
    if (!this.pageProjectIdByHostId.has(hostProjectId)) {
      this.pageProjectIdByHostId.set(hostProjectId, this.createHandle('project'))
    }
  }

  private rememberExecutionHost(hostExecutionHostId: ExecutionHostId): void {
    if (this.pageExecutionHostIdByHostId.has(hostExecutionHostId)) {
      return
    }
    const host = parseExecutionHostId(hostExecutionHostId)
    if (!host || host.kind === 'local') {
      this.pageExecutionHostIdByHostId.set(hostExecutionHostId, 'local')
      return
    }
    this.pageExecutionHostIdByHostId.set(
      hostExecutionHostId,
      `${host.kind}:${this.createHandle('executionHost')}`
    )
  }

  private createHandle(prefix: 'workspace' | 'repo' | 'project' | 'executionHost'): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextHandle.toString(36)
    this.nextHandle += 1
    return `${prefix}_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
