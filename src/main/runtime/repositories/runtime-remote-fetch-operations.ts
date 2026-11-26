import type { LocalGitExecOptions } from '../../git/refs/resolution/repo-default-base-ref'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import { RuntimeProvisionedWorkspaceAdoption } from '../workspaces/creation/runtime-provisioned-workspace-adoption'

export abstract class RuntimeRemoteFetchOperations extends RuntimeProvisionedWorkspaceAdoption {
  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<string> {
    return await this.remoteFetches.getCanonicalFetchKey(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteTrackingBaseRefresh(repoPath, base, gitOptions)
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<void> {
    await this.remoteFetches.fetchRemoteWithCache(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteTrackingBase | null> {
    return await this.remoteFetches.resolveRemoteTrackingBase(repoPath, baseBranch, gitOptions)
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<boolean> {
    return await this.remoteFetches.hasRemoteTrackingRef(repoPath, base, gitOptions)
  }
}
