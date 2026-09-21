import type {
  AgentSkillShareOperation,
  AgentSkillShareResult
} from '../../shared/agent-skill-sharing-contract'
import {
  AGENT_SKILL_SHARING_DISABLED_CODE,
  AGENT_SKILL_SHARING_DISABLED_MESSAGE,
  AGENT_SKILL_SHARING_DISABLED_NEXT_STEPS
} from '../../shared/agent-skill-sharing-gate'
import { normalizeSkillBundleName } from '../../shared/skill-bundle-name'
import type { SkillCloudOperation } from '../../shared/skill-cloud-contract'
import type { SkillDiscoveryResult } from '../../shared/skills'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRepeatedStringFlag } from '../flags'
import { printResult } from '../format'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from '../runtime-client'

const SHARE_TIMEOUT_MS = 10 * 60_000

type InstalledSkillSummary = Pick<
  SkillDiscoveryResult['skills'][number],
  'id' | 'name' | 'description' | 'providers' | 'sourceKind' | 'sourceLabel'
>

type SharedSkillSummary = {
  url: string
  shareId: string
  packageId: string
  versionId: string
  bundleName: string
  skills: AgentSkillShareResult['selectedSkills']
}

function stringFlag(ctx: HandlerContext, name: string): string | undefined {
  const value = ctx.flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function rejectForwardedSkillFilesystem(ctx: HandlerContext, command: string): void {
  if (!process.env.ORCA_CLI_CWD && !ctx.client.isRemote) {
    return
  }
  throw new RuntimeClientError(
    'invalid_environment',
    `orca skills ${command} must run on the machine whose installed skills you want to use. Run the command from an Orca terminal on that machine.`
  )
}

async function preflightPublishCapability(ctx: HandlerContext): Promise<void> {
  let enabled: unknown
  try {
    const response = await ctx.client.call<{
      settings?: { agentSkillSharingEnabled?: boolean }
    }>('settings.get')
    enabled = response.result?.settings?.agentSkillSharingEnabled
  } catch {
    return
  }
  if (enabled === false) {
    throw new RuntimeClientError(
      AGENT_SKILL_SHARING_DISABLED_CODE,
      AGENT_SKILL_SHARING_DISABLED_MESSAGE,
      { nextSteps: [...AGENT_SKILL_SHARING_DISABLED_NEXT_STEPS] }
    )
  }
}

function requireCloudOperation<T>(operation: SkillCloudOperation<T>): T {
  if (operation.status === 'ok') {
    return operation.value
  }
  if (operation.status === 'reconnect-required') {
    throw new RuntimeClientError('authentication_required', 'Sign in to Orca and try again.')
  }
  throw new RuntimeClientError('authentication_unconfigured', operation.message)
}

function installedSummary(result: SkillDiscoveryResult): InstalledSkillSummary[] {
  return result.skills.map(({ id, name, description, providers, sourceKind, sourceLabel }) => ({
    id,
    name,
    description,
    providers,
    sourceKind,
    sourceLabel
  }))
}

function formatInstalledSkills(skills: InstalledSkillSummary[]): string {
  if (skills.length === 0) {
    return 'No installed skills found.'
  }
  return skills
    .map(
      (skill) =>
        `${skill.name} (${skill.id})\n  ${skill.description ?? 'No description'}\n  ${skill.sourceLabel}`
    )
    .join('\n')
}

function sharedSummary(result: AgentSkillShareResult): SharedSkillSummary {
  return {
    url: result.share.url,
    shareId: result.share.id,
    packageId: result.version.packageId,
    versionId: result.version.versionId,
    bundleName: result.version.name,
    skills: result.selectedSkills
  }
}

function formatSharedSkill(result: SharedSkillSummary): string {
  return `Shared ${result.skills.length} skill${result.skills.length === 1 ? '' : 's'}: ${result.url}`
}

async function callShare(
  ctx: HandlerContext,
  params: {
    skillSelectors: string[]
    bundleName: string
    releaseNotes: string
    target: { cwd: string }
  }
): Promise<RuntimeRpcSuccess<AgentSkillShareOperation>> {
  try {
    return await ctx.client.call<AgentSkillShareOperation>('skills.share', params, {
      timeoutMs: SHARE_TIMEOUT_MS
    })
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'update_required',
        'The connected Orca runtime does not support agent skill sharing yet. Update Orca on that machine and try again.'
      )
    }
    throw error
  }
}

export const SKILL_SHARING_HANDLERS: Record<string, CommandHandler> = {
  'skills installed': async (ctx) => {
    rejectForwardedSkillFilesystem(ctx, 'installed')
    const response = await ctx.client.call<SkillDiscoveryResult>('skills.discover', {
      cwd: ctx.cwd
    })
    const skills = installedSummary(response.result)
    printResult({ ...response, result: { skills } }, ctx.json, (value) =>
      formatInstalledSkills(value.skills)
    )
  },
  'skills share': async (ctx) => {
    rejectForwardedSkillFilesystem(ctx, 'share')
    const skillSelectors = getRepeatedStringFlag(ctx.flags, 'skill')
    if (skillSelectors.length === 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Select at least one installed skill with --skill. Run `orca skills installed` to list them.'
      )
    }
    const bundleLabel = stringFlag(ctx, 'bundle-name')
    if (!bundleLabel) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --bundle-name.')
    }
    const bundleName = normalizeSkillBundleName(bundleLabel)
    if (!bundleName) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--bundle-name must contain at least one English letter or number.'
      )
    }
    await preflightPublishCapability(ctx)
    const response = await callShare(ctx, {
      skillSelectors,
      bundleName,
      releaseNotes: stringFlag(ctx, 'release-notes') ?? '',
      target: { cwd: ctx.cwd }
    })
    const value = sharedSummary(requireCloudOperation(response.result))
    printResult({ ...response, result: value }, ctx.json, formatSharedSkill)
  }
}
