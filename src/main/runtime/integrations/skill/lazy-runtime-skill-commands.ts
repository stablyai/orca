import {
  assertAgentSkillSharingAllowed,
  isAgentSkillSharingEnabled
} from '../../../../shared/skills/sharing/agent-skill-sharing-gate'
import { SharingUnavailableOnHostError } from '../../../../shared/remote-runtime/host-status/sharing-unavailable-on-host'
import type { SkillCloudService } from '../../../skills/cloud/skill-cloud-package-service'
import type {
  RuntimeSkillCommandHost,
  RuntimeSkillCommandOwner
} from './runtime-skill-command-contract'
import type { RuntimeSkillCommands } from './runtime-skill-command-surface'

type LazySkillState = {
  readonly host: RuntimeSkillCommandHost
  skillCloudService: SkillCloudService | null
  loaded: RuntimeSkillCommands | null
  loadingPromise: Promise<RuntimeSkillCommands> | null
}

const lazyStates = new WeakMap<LazyRuntimeSkillCommands, LazySkillState>()

function getState(owner: LazyRuntimeSkillCommands): LazySkillState {
  const state = lazyStates.get(owner)
  if (!state) {
    throw new Error('LazyRuntimeSkillCommands state missing')
  }
  return state
}

function loadSkillCommands(owner: LazyRuntimeSkillCommands): Promise<RuntimeSkillCommands> {
  const state = getState(owner)
  if (state.loaded) {
    return Promise.resolve(state.loaded)
  }
  if (!state.loadingPromise) {
    state.loadingPromise = import('./runtime-skill-command-surface')
      .then(({ RuntimeSkillCommands: Ctor }) => {
        const instance = new Ctor(state.host)
        if (state.skillCloudService) {
          instance.setSkillCloudService(state.skillCloudService)
        }
        state.loaded = instance
        return instance
      })
      .catch((error: unknown) => {
        state.loadingPromise = null
        throw error
      })
  }
  return state.loadingPromise
}

export class LazyRuntimeSkillCommands implements RuntimeSkillCommandOwner {
  constructor(host: RuntimeSkillCommandHost) {
    lazyStates.set(this, {
      host,
      skillCloudService: null,
      loaded: null,
      loadingPromise: null
    })
  }

  setSkillCloudService(service: SkillCloudService): void {
    const state = getState(this)
    state.skillCloudService = service
    state.loaded?.setSkillCloudService(service)
  }

  hasSkillCloudService(): boolean {
    return getState(this).skillCloudService !== null
  }

  assertAgentSkillSharingAllowed(): void {
    const state = getState(this)
    if (!state.skillCloudService) {
      throw new SharingUnavailableOnHostError()
    }
    assertAgentSkillSharingAllowed(() => isAgentSkillSharingEnabled(state.host.getSettings()))
  }

  async publishDiscoveredSkillsFromAgent(
    ...args: Parameters<RuntimeSkillCommandOwner['publishDiscoveredSkillsFromAgent']>
  ) {
    return (await loadSkillCommands(this)).publishDiscoveredSkillsFromAgent(...args)
  }

  async publishSkillPackage(...args: Parameters<RuntimeSkillCommandOwner['publishSkillPackage']>) {
    return (await loadSkillCommands(this)).publishSkillPackage(...args)
  }

  async publishSkillPackageVersion(
    ...args: Parameters<RuntimeSkillCommandOwner['publishSkillPackageVersion']>
  ) {
    return (await loadSkillCommands(this)).publishSkillPackageVersion(...args)
  }

  async findOwnedSkillPackageId(
    ...args: Parameters<RuntimeSkillCommandOwner['findOwnedSkillPackageId']>
  ) {
    return (await loadSkillCommands(this)).findOwnedSkillPackageId(...args)
  }

  async createSkillPackageShare(
    ...args: Parameters<RuntimeSkillCommandOwner['createSkillPackageShare']>
  ) {
    return (await loadSkillCommands(this)).createSkillPackageShare(...args)
  }

  async resolveSkillShare(...args: Parameters<RuntimeSkillCommandOwner['resolveSkillShare']>) {
    return (await loadSkillCommands(this)).resolveSkillShare(...args)
  }

  async createSkillDownloadGrant(
    ...args: Parameters<RuntimeSkillCommandOwner['createSkillDownloadGrant']>
  ) {
    return (await loadSkillCommands(this)).createSkillDownloadGrant(...args)
  }

  async createSkillPackageVersionDownloadGrant(
    ...args: Parameters<RuntimeSkillCommandOwner['createSkillPackageVersionDownloadGrant']>
  ) {
    return (await loadSkillCommands(this)).createSkillPackageVersionDownloadGrant(...args)
  }

  async getSkillPackage(...args: Parameters<RuntimeSkillCommandOwner['getSkillPackage']>) {
    return (await loadSkillCommands(this)).getSkillPackage(...args)
  }

  async listOwnedSkillShares(
    ...args: Parameters<RuntimeSkillCommandOwner['listOwnedSkillShares']>
  ) {
    return (await loadSkillCommands(this)).listOwnedSkillShares(...args)
  }

  async revokeSkillShare(...args: Parameters<RuntimeSkillCommandOwner['revokeSkillShare']>) {
    return (await loadSkillCommands(this)).revokeSkillShare(...args)
  }

  async deleteSkillPackage(...args: Parameters<RuntimeSkillCommandOwner['deleteSkillPackage']>) {
    return (await loadSkillCommands(this)).deleteSkillPackage(...args)
  }

  async installSharedSkillRequest(
    ...args: Parameters<RuntimeSkillCommandOwner['installSharedSkillRequest']>
  ) {
    return (await loadSkillCommands(this)).installSharedSkillRequest(...args)
  }

  async installSharedSkillBundleRequest(
    ...args: Parameters<RuntimeSkillCommandOwner['installSharedSkillBundleRequest']>
  ) {
    return (await loadSkillCommands(this)).installSharedSkillBundleRequest(...args)
  }

  async planLocalBundledSkills(
    ...args: Parameters<RuntimeSkillCommandOwner['planLocalBundledSkills']>
  ) {
    return (await loadSkillCommands(this)).planLocalBundledSkills(...args)
  }

  async executeLocalBundledSkills(
    ...args: Parameters<RuntimeSkillCommandOwner['executeLocalBundledSkills']>
  ) {
    return (await loadSkillCommands(this)).executeLocalBundledSkills(...args)
  }

  async autoUpdateLocalBundledSkills(
    ...args: Parameters<RuntimeSkillCommandOwner['autoUpdateLocalBundledSkills']>
  ) {
    return (await loadSkillCommands(this)).autoUpdateLocalBundledSkills(...args)
  }

  getSharedSkillInstallProgress(operationId: string) {
    return getState(this).loaded?.getSharedSkillInstallProgress(operationId) ?? null
  }

  cancelSharedSkillInstall(operationId: string) {
    return getState(this).loaded?.cancelSharedSkillInstall(operationId) ?? false
  }

  async previewSharedSkillInstallRequest(
    ...args: Parameters<RuntimeSkillCommandOwner['previewSharedSkillInstallRequest']>
  ) {
    return (await loadSkillCommands(this)).previewSharedSkillInstallRequest(...args)
  }

  async previewSharedSkillBundleInstallRequest(
    ...args: Parameters<RuntimeSkillCommandOwner['previewSharedSkillBundleInstallRequest']>
  ) {
    return (await loadSkillCommands(this)).previewSharedSkillBundleInstallRequest(...args)
  }

  async removeSharedSkillInstallRequest(
    ...args: Parameters<RuntimeSkillCommandOwner['removeSharedSkillInstallRequest']>
  ) {
    return (await loadSkillCommands(this)).removeSharedSkillInstallRequest(...args)
  }

  async listManagedSkillInstalls(
    ...args: Parameters<RuntimeSkillCommandOwner['listManagedSkillInstalls']>
  ) {
    return (await loadSkillCommands(this)).listManagedSkillInstalls(...args)
  }

  async skillInstallDestinationUsesSsh(
    ...args: Parameters<RuntimeSkillCommandOwner['skillInstallDestinationUsesSsh']>
  ) {
    return (await loadSkillCommands(this)).skillInstallDestinationUsesSsh(...args)
  }

  async resolveSkillDiscoveryProviderRoots(
    ...args: Parameters<RuntimeSkillCommandOwner['resolveSkillDiscoveryProviderRoots']>
  ) {
    return (await loadSkillCommands(this)).resolveSkillDiscoveryProviderRoots(...args)
  }

  async beginSkillUpload(...args: Parameters<RuntimeSkillCommandOwner['beginSkillUpload']>) {
    return (await loadSkillCommands(this)).beginSkillUpload(...args)
  }

  async appendSkillUploadChunk(
    ...args: Parameters<RuntimeSkillCommandOwner['appendSkillUploadChunk']>
  ) {
    return (await loadSkillCommands(this)).appendSkillUploadChunk(...args)
  }

  async commitSkillUpload(...args: Parameters<RuntimeSkillCommandOwner['commitSkillUpload']>) {
    return (await loadSkillCommands(this)).commitSkillUpload(...args)
  }

  async cancelSkillUpload(...args: Parameters<RuntimeSkillCommandOwner['cancelSkillUpload']>) {
    return (await loadSkillCommands(this)).cancelSkillUpload(...args)
  }

  async disposeSkillUploadSessions(): Promise<void> {
    const state = getState(this)
    if (state.loaded) {
      return state.loaded.disposeSkillUploadSessions()
    }
    if (state.loadingPromise) {
      const instance = await state.loadingPromise.catch(() => null)
      if (instance) {
        return instance.disposeSkillUploadSessions()
      }
    }
  }
}
