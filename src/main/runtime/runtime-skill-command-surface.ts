import { join } from 'node:path'
import {
  assertAgentSkillSharingAllowed,
  isAgentSkillSharingEnabled
} from '../../shared/agent-skill-sharing-gate'
import {
  AGENT_SKILL_BUNDLE_NAME_TAKEN_CODE,
  AGENT_SKILL_NOT_SHAREABLE_CODE,
  AGENT_SKILL_SHARING_BUSY_CODE,
  AgentSkillSharingError,
  type AgentSkillShareOperation,
  type AgentSkillShareRequest
} from '../../shared/agent-skill-sharing-contract'
import type { DiscoveredSkill } from '../../shared/skills'
import { SharingUnavailableOnHostError } from '../../shared/sharing-unavailable-on-host'
import { SKILL_SHARE_NAME_TAKEN_ERROR } from '../../shared/skill-sharing-contract'
import { selectDiscoveredSkills } from '../skills/agent-skill-selection'
import { SkillSharePreparationService } from '../skills/skill-share-preparation-service'
import { RuntimeSkillInstallQueries } from './runtime-skill-install-queries'
import type {
  RuntimeSkillCommandSurface,
  RuntimeSkillCommandHost
} from './runtime-skill-command-contract'
import type { SkillCloudOptions, SkillCloudPublishRequest } from '../../shared/skill-cloud-contract'
import type { SkillCloudService } from '../skills/skill-cloud-service'

export class RuntimeSkillCommands
  extends RuntimeSkillInstallQueries
  implements RuntimeSkillCommandSurface
{
  private skillCloudService: SkillCloudService | null = null
  private skillShareInProgress = false

  constructor(host: RuntimeSkillCommandHost) {
    super(host)
  }

  setSkillCloudService(service: SkillCloudService): void {
    this.skillCloudService = service
  }
  hasSkillCloudService(): boolean {
    return this.skillCloudService !== null
  }
  assertAgentSkillSharingAllowed(): void {
    // A host with no sharing service must not blame the device setting it cannot change.
    this.requireCloud()
    assertAgentSkillSharingAllowed(() => isAgentSkillSharingEnabled(this.host.getSettings()))
  }
  private requireCloud(): SkillCloudService {
    if (!this.skillCloudService) {
      throw new SharingUnavailableOnHostError()
    }
    return this.skillCloudService
  }
  async publishDiscoveredSkillsFromAgent(
    request: AgentSkillShareRequest,
    discoveredSkills: readonly DiscoveredSkill[],
    signal?: AbortSignal
  ): Promise<AgentSkillShareOperation> {
    this.assertAgentSkillSharingAllowed()
    if (this.skillShareInProgress) {
      throw new AgentSkillSharingError(
        AGENT_SKILL_SHARING_BUSY_CODE,
        'Another agent skill bundle is being published. Wait for it to finish and try again.'
      )
    }
    this.skillShareInProgress = true
    try {
      const selected = selectDiscoveredSkills(discoveredSkills, request.skillSelectors)
      const cloud = this.requireCloud()
      const preparations = new SkillSharePreparationService(
        join(this.userDataPath(), 'agent-skill-share-operations'),
        {
          findOwnedPackageId: (name, input) => cloud.findOwnedPackageId(name, input),
          publishVersion: (input) => cloud.publishVersion(input),
          createShare: (packageId, input) => cloud.createShare(packageId, input)
        },
        { installStateDirectory: join(this.userDataPath(), 'skill-installs') }
      )
      let preparationId: string | null = null
      const cancel = () => {
        if (preparationId) {
          preparations.cancel(preparationId)
        }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        if (signal?.aborted) {
          throw signal.reason ?? new Error('skill-share-cancelled')
        }
        const preview = await preparations
          .prepare({
            sources: selected.map((skill) => ({
              id: skill.name,
              sourceDirectory: skill.directoryPath
            })),
            bundleName: request.bundleName,
            description:
              selected.length === 1
                ? (selected[0].description ?? '')
                : `${selected.length} shared skills`
          })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              ['skill-package-skill-name-required', 'skill-package-skill-name-invalid'].includes(
                error.message
              )
            ) {
              throw new AgentSkillSharingError(
                AGENT_SKILL_NOT_SHAREABLE_CODE,
                'A selected skill cannot be shared. Its SKILL.md must declare a lowercase name containing only letters, numbers, and hyphens.'
              )
            }
            throw error
          })
        preparationId = preview.preparationId
        if (signal?.aborted) {
          throw signal.reason ?? new Error('skill-share-cancelled')
        }
        this.assertAgentSkillSharingAllowed()
        const published = await preparations.publish({
          preparationId,
          releaseNotes: request.releaseNotes
        })
        return published.status === 'ok'
          ? {
              status: 'ok',
              value: {
                ...published.value,
                selectedSkills: selected.map(({ id, name, description }) => ({
                  id,
                  name,
                  description
                }))
              }
            }
          : published
      } catch (error) {
        if (error instanceof Error && error.message === SKILL_SHARE_NAME_TAKEN_ERROR) {
          throw new AgentSkillSharingError(
            AGENT_SKILL_BUNDLE_NAME_TAKEN_CODE,
            `The skill bundle name "${request.bundleName}" is already in use. Choose a different --bundle-name.`
          )
        }
        throw error
      } finally {
        signal?.removeEventListener('abort', cancel)
        await preparations.dispose()
      }
    } finally {
      this.skillShareInProgress = false
    }
  }

  publishSkillPackage(request: SkillCloudPublishRequest) {
    return this.requireCloud().publish(request)
  }

  publishSkillPackageVersion(request: SkillCloudPublishRequest) {
    return this.requireCloud().publishVersion(request)
  }
  findOwnedSkillPackageId(name: string, options: SkillCloudOptions) {
    return this.requireCloud().findOwnedPackageId(name, options)
  }
  createSkillPackageShare(
    packageId: string,
    request: SkillCloudOptions & { pinnedVersionId?: string; idempotencyKey?: string }
  ) {
    return this.requireCloud().createShare(packageId, request)
  }
  resolveSkillShare(shareId: string, options: SkillCloudOptions) {
    return this.requireCloud().resolveShare(shareId, options)
  }
  createSkillDownloadGrant(
    shareId: string,
    options: SkillCloudOptions & { versionId?: string; installTarget?: 'local' | 'remote' }
  ) {
    return this.requireCloud().createDownloadGrant(shareId, options)
  }
  createSkillPackageVersionDownloadGrant(
    packageId: string,
    versionId: string,
    options: SkillCloudOptions & { installTarget?: 'local' | 'remote' }
  ) {
    return this.requireCloud().createPackageVersionDownloadGrant(packageId, versionId, options)
  }
  getSkillPackage(packageId: string, options: SkillCloudOptions) {
    return this.requireCloud().getPackage(packageId, options)
  }
  listOwnedSkillShares(options: SkillCloudOptions) {
    return this.requireCloud().listOwnedShares(options)
  }
  revokeSkillShare(shareId: string, options: SkillCloudOptions) {
    return this.requireCloud().revokeShare(shareId, options)
  }
  deleteSkillPackage(packageId: string, options: SkillCloudOptions) {
    return this.requireCloud().deletePackage(packageId, options)
  }
}
