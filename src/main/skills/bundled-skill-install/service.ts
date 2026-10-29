import type {
  BundledSkillInstallResult,
  BundledSkillPlan
} from '../../../shared/bundled-skill-plan'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-sources'
import { executeBundledSkillPlan, type BundledSkillExecuteInput } from './execute'
import { nativeBundledSkillFilesystem } from './filesystem'
import { buildBundledSkillPlan } from './plan'

export type BundledSkillServiceInput = Omit<BundledSkillExecuteInput, 'filesystem' | 'sources'> &
  Partial<Pick<BundledSkillExecuteInput, 'filesystem' | 'sources'>>

function withDefaults(input: BundledSkillServiceInput): BundledSkillExecuteInput {
  return {
    ...input,
    filesystem: input.filesystem ?? nativeBundledSkillFilesystem,
    sources: input.sources ?? BUNDLED_SKILL_SOURCES
  }
}

export async function previewBundledSkillInstall(
  input: BundledSkillServiceInput
): Promise<BundledSkillPlan> {
  return (await buildBundledSkillPlan(withDefaults(input))).plan
}

/** Execute by preview digest, never by client-supplied operations. */
export async function installBundledSkills(
  input: BundledSkillServiceInput,
  planDigest: string
): Promise<BundledSkillInstallResult> {
  return executeBundledSkillPlan(withDefaults(input), planDigest)
}
