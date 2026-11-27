import { defineMethod } from '../../core'
import { resolveDiscoveryTarget } from './skills-discovery-target'
import { SKILLS_SHARE_METHOD } from './skills-share-method'
import type { z } from 'zod'
import { getAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'
import { SkillDeleteRequestSchema } from '../../../../../shared/skills/deletion/skill-delete-contract'
import {
  BundledSkillAutoUpdateRequestSchema,
  BundledSkillExecuteRequestSchema,
  BundledSkillPlanRequestSchema
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import {
  previewSkillDeleteRequest,
  runSkillDeleteRequest,
  type SkillDeleteRequestDependencies
} from '../../../../skills/skill-delete/skill-delete-request'
import {
  SkillInstallPreviewRequestSchema,
  SkillInstallRequestSchema,
  SkillRemoveRequestSchema
} from '../../../../../shared/skills/installation/skill-install-contract'
import {
  SkillBundleInstallProgressSchema,
  SkillBundleInstallRequestSchema
} from '../../../../../shared/skills/installation/skill-bundle-install-contract'
import {
  SkillUploadBeginRequestSchema,
  SkillUploadChunkRequestSchema,
  SkillUploadCommitRequestSchema
} from '../../../../../shared/skills/sharing/skill-upload-session-contract'
import {
  discoverSkillsOnTarget,
  type ResolvedSkillDiscoveryTarget
} from '../../../../skills/discovery/skill-discovery-target'
import { SKILL_INSTALL_RESULT_V2_CAPABILITY } from '../../../../../shared/skills/capabilities/skill-install-capability'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  SkillsCancelInstallParams,
  SkillsDiscoverParams,
  SkillsGetInstallProgressParams
} from '../../../../../shared/rpc-contract/skills/skills-params'
import { unavailableWhileWslDistroStopped } from '../../../../skills/discovery/skill-discovery-stopped-wsl-roots'

// A caller naming only the workspace gets its folder from the host, which refuses SSH workspaces like desktop.
async function withWorkspaceCwd(
  params: z.infer<typeof SkillsDiscoverParams>,
  runtime: Pick<OrcaRuntimeService, 'resolveRuntimeFileTarget'>
): Promise<z.infer<typeof SkillsDiscoverParams>> {
  if (params.cwd?.trim() || !params.worktreeId) {
    return params
  }
  const target = await runtime.resolveRuntimeFileTarget(`id:${params.worktreeId}`)
  if (parseExecutionHostId(target.executionHostId)?.kind === 'ssh') {
    throw new Error('Skill discovery is unavailable for SSH hosts.')
  }
  return { ...params, cwd: target.worktree.path }
}

// A bot's chats also load its linked projects' skills, so its home lists them as chat does.
function withBotLinkedSkills(
  target: ResolvedSkillDiscoveryTarget,
  linkedSkillsFolder: string | null
): ResolvedSkillDiscoveryTarget {
  return linkedSkillsFolder && target.kind === 'native-host'
    ? { ...target, linkedSkillsFolder }
    : target
}

function skillDeleteDependencies(
  runtime: Pick<OrcaRuntimeService, 'listRepos' | 'resolveSkillDiscoveryProviderRoots'>
): SkillDeleteRequestDependencies {
  return {
    repos: () => runtime.listRepos(),
    resolveProviderRootOverrides: (target) => runtime.resolveSkillDiscoveryProviderRoots(target),
    userDataPath: getAppEnvironment().getPath('userData')
  }
}

export const SKILL_METHODS = [
  defineMethod({
    name: 'skills.discover',
    permission: 'workspace',
    share: 'not-shared',
    params: SkillsDiscoverParams,
    handler: async (params, { runtime }) =>
      unavailableWhileWslDistroStopped(async () => {
        // Resolve WSL preferences on the executing host; remote clients provide workspace identity, not trusted runtime absence.
        const resolvedTarget = withBotLinkedSkills(
          await resolveDiscoveryTarget(await withWorkspaceCwd(params, runtime), runtime, {
            refuseStoppedWslDistro: true
          }),
          runtime.botLinkedSkillsFolderOfHome(params.worktreeId)
        )
        return discoverSkillsOnTarget(resolvedTarget, runtime.listRepos(), {
          providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(resolvedTarget),
          refresh: params.refresh === true
        })
      }, params.sourceKinds)
  }),
  defineMethod({
    name: 'skills.previewDelete',
    permission: 'workspace',
    share: 'not-shared',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      previewSkillDeleteRequest(
        params,
        await resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  defineMethod({
    name: 'skills.delete',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      runSkillDeleteRequest(
        params,
        await resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  // The host plans Orca's skills on its own disk; a paired client never sends a WSL target.
  defineMethod({
    name: 'skills.planBundledOrca',
    permission: 'workspace',
    share: 'not-shared',
    params: BundledSkillPlanRequestSchema,
    handler: (params, { runtime }) => runtime.planLocalBundledSkills(params)
  }),
  defineMethod({
    name: 'skills.executeBundledOrca',
    permission: 'skills-admin',
    share: 'not-shared',
    params: BundledSkillExecuteRequestSchema,
    handler: (params, { runtime }) => runtime.executeLocalBundledSkills(params)
  }),
  defineMethod({
    name: 'skills.autoUpdateBundledOrca',
    permission: 'skills-admin',
    share: 'not-shared',
    params: BundledSkillAutoUpdateRequestSchema,
    handler: (params, { runtime }) => runtime.autoUpdateLocalBundledSkills(params)
  }),
  SKILLS_SHARE_METHOD,
  defineMethod({
    name: 'skills.install',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillInstallRequestSchema,
    handler: async (params, { runtime, signal, clientCapabilities }) => {
      const result = await runtime.installSharedSkillRequest(params, signal)
      if (
        result.status === 'cancelled' &&
        !clientCapabilities?.includes(SKILL_INSTALL_RESULT_V2_CAPABILITY)
      ) {
        return {
          ...result,
          status: 'failed' as const,
          errorCategory: result.failure?.code ?? 'skill-install-cancelled',
          failure: undefined
        }
      }
      return result
    }
  }),
  defineMethod({
    name: 'skills.installBundle',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillBundleInstallRequestSchema,
    handler: (params, { runtime, signal }) =>
      runtime.installSharedSkillBundleRequest(params, signal)
  }),
  defineMethod({
    name: 'skills.cancelInstall',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillsCancelInstallParams,
    handler: (params, { runtime }) => ({
      cancelled: runtime.cancelSharedSkillInstall(params.operationId)
    })
  }),
  defineMethod({
    name: 'skills.getInstallProgress',
    permission: 'workspace',
    share: 'not-shared',
    params: SkillsGetInstallProgressParams,
    handler: (params, { runtime }) => {
      const progress = runtime.getSharedSkillInstallProgress(params.operationId)
      return progress ? SkillBundleInstallProgressSchema.parse(progress) : null
    }
  }),
  defineMethod({
    name: 'skills.previewInstall',
    permission: 'workspace',
    share: 'not-shared',
    params: SkillInstallPreviewRequestSchema,
    handler: (params, { runtime }) => runtime.previewSharedSkillInstallRequest(params)
  }),
  defineMethod({
    name: 'skills.removeInstall',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillRemoveRequestSchema,
    handler: (params, { runtime }) => runtime.removeSharedSkillInstallRequest(params)
  }),
  defineMethod({
    name: 'skills.listManagedInstalls',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => runtime.listManagedSkillInstalls()
  }),
  defineMethod({
    name: 'skills.beginUpload',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillUploadBeginRequestSchema,
    handler: (params, { runtime }) => runtime.beginSkillUpload(params)
  }),
  defineMethod({
    name: 'skills.uploadChunk',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillUploadChunkRequestSchema,
    handler: (params, { runtime }) => runtime.appendSkillUploadChunk(params)
  }),
  defineMethod({
    name: 'skills.commitUpload',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillUploadCommitRequestSchema,
    handler: (params, { runtime }) => runtime.commitSkillUpload(params.uploadId)
  }),
  defineMethod({
    name: 'skills.cancelUpload',
    permission: 'skills-admin',
    share: 'not-shared',
    params: SkillUploadCommitRequestSchema,
    handler: (params, { runtime }) => runtime.cancelSkillUpload(params.uploadId)
  })
]
