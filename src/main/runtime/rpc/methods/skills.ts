import { defineMethod } from '../core'
import type { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { SkillDeleteRequestSchema } from '../../../../shared/skill-delete-contract'
import {
  previewSkillDeleteRequest,
  runSkillDeleteRequest,
  type SkillDeleteRequestDependencies
} from '../../../skills/skill-delete/request-service'
import type { SkillDiscoveryTargetSchema } from '../../../../shared/skills'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import {
  SkillInstallPreviewRequestSchema,
  SkillInstallRequestSchema,
  SkillRemoveRequestSchema
} from '../../../../shared/skill-install-contract'
import {
  SkillBundleInstallProgressSchema,
  SkillBundleInstallRequestSchema
} from '../../../../shared/skill-bundle-install-contract'
import {
  SkillUploadBeginRequestSchema,
  SkillUploadChunkRequestSchema,
  SkillUploadCommitRequestSchema
} from '../../../../shared/skill-upload-session-contract'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../../../skills/skill-discovery-target'
import { SKILL_INSTALL_RESULT_V2_CAPABILITY } from '../../../../shared/skill-install-capability'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
  AgentSkillShareRequestSchema,
  AgentSkillSharingError
} from '../../../../shared/agent-skill-sharing-contract'
import {
  SkillsCancelInstallParams,
  SkillsDiscoverParams,
  SkillsGetInstallProgressParams
} from '../../../../shared/rpc-contract/skills-params'

/** Exported so the delete plan's root rebuild resolves its target exactly the
 *  way `skills.discover` resolved the scan's — including WSL. */
export function resolveDiscoveryTarget(
  params: z.infer<typeof SkillDiscoveryTargetSchema>,
  runtime: Pick<OrcaRuntimeService, 'resolveProjectRuntimeForWorktree'>
) {
  // Why: plugin enablement lives in the worktree's own .claude/settings.json,
  // so a caller that knows only the worktree id (a paired phone) still needs
  // the scan to see project plugin roots — recover the cwd the id carries.
  const cwd =
    params.cwd ??
    (params.worktreeId ? splitWorktreeIdForFilesystem(params.worktreeId)?.worktreePath : undefined)
  const target = params.projectRuntime
    ? { ...params, cwd }
    : {
        ...params,
        cwd,
        projectRuntime: runtime.resolveProjectRuntimeForWorktree(params.worktreeId)
      }
  return resolveSkillDiscoveryTarget(target)
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
    params: SkillsDiscoverParams,
    handler: async (params, { runtime }) => {
      // Why: the executing runtime owns WSL project preferences. Remote callers
      // send worktree identity only; trusting their projectRuntime absence
      // would scan this host's native filesystem for a WSL-configured project.
      const resolvedTarget = resolveDiscoveryTarget(params, runtime)
      return discoverSkillsOnTarget(resolvedTarget, runtime.listRepos(), {
        providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(resolvedTarget),
        refresh: params.refresh === true
      })
    }
  }),
  defineMethod({
    name: 'skills.previewDelete',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      previewSkillDeleteRequest(
        params,
        resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  defineMethod({
    name: 'skills.delete',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      runSkillDeleteRequest(
        params,
        resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  defineMethod({
    name: 'skills.share',
    params: AgentSkillShareRequestSchema,
    handler: async (params, { runtime, signal, clientKind }) => {
      runtime.assertAgentSkillSharingAllowed()
      if (clientKind !== undefined) {
        throw new AgentSkillSharingError(
          AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
          'Publishing skills through a paired client is not supported. Run the command from Orca on the machine that stores the skills.'
        )
      }
      const resolvedTarget = resolveDiscoveryTarget(params.target ?? {}, runtime)
      if (resolvedTarget.kind !== 'native-host') {
        throw new AgentSkillSharingError(
          AGENT_SKILL_SHARING_UNSUPPORTED_ENVIRONMENT_CODE,
          'Publishing skills from a forwarded WSL session is not supported yet. Run the command from Orca on the machine that stores the skills.'
        )
      }
      const discovered = await discoverSkillsOnTarget(resolvedTarget, runtime.listRepos(), {
        providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(resolvedTarget),
        refresh: true
      })
      return runtime.publishDiscoveredSkillsFromAgent(params, discovered.skills, signal)
    }
  }),
  defineMethod({
    name: 'skills.install',
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
    params: SkillBundleInstallRequestSchema,
    handler: (params, { runtime, signal }) =>
      runtime.installSharedSkillBundleRequest(params, signal)
  }),
  defineMethod({
    name: 'skills.cancelInstall',
    params: SkillsCancelInstallParams,
    handler: (params, { runtime }) => ({
      cancelled: runtime.cancelSharedSkillInstall(params.operationId)
    })
  }),
  defineMethod({
    name: 'skills.getInstallProgress',
    params: SkillsGetInstallProgressParams,
    handler: (params, { runtime }) => {
      const progress = runtime.getSharedSkillInstallProgress(params.operationId)
      return progress ? SkillBundleInstallProgressSchema.parse(progress) : null
    }
  }),
  defineMethod({
    name: 'skills.previewInstall',
    params: SkillInstallPreviewRequestSchema,
    handler: (params, { runtime }) => runtime.previewSharedSkillInstallRequest(params)
  }),
  defineMethod({
    name: 'skills.removeInstall',
    params: SkillRemoveRequestSchema,
    handler: (params, { runtime }) => runtime.removeSharedSkillInstallRequest(params)
  }),
  defineMethod({
    name: 'skills.listManagedInstalls',
    params: null,
    handler: (_params, { runtime }) => runtime.listManagedSkillInstalls()
  }),
  defineMethod({
    name: 'skills.beginUpload',
    params: SkillUploadBeginRequestSchema,
    handler: (params, { runtime }) => runtime.beginSkillUpload(params)
  }),
  defineMethod({
    name: 'skills.uploadChunk',
    params: SkillUploadChunkRequestSchema,
    handler: (params, { runtime }) => runtime.appendSkillUploadChunk(params)
  }),
  defineMethod({
    name: 'skills.commitUpload',
    params: SkillUploadCommitRequestSchema,
    handler: (params, { runtime }) => runtime.commitSkillUpload(params.uploadId)
  }),
  defineMethod({
    name: 'skills.cancelUpload',
    params: SkillUploadCommitRequestSchema,
    handler: (params, { runtime }) => runtime.cancelSkillUpload(params.uploadId)
  })
]
