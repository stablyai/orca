import {
  bundledSkillVerdict,
  type BundledSkillPlan,
  type SkillFreshnessInventory
} from '../../shared/skill-freshness'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import { bundledOrcaSkillNames } from './bundled-orca-skill-plan'

export type BundledSkillPlanner = (names: readonly string[]) => Promise<BundledSkillPlan[]>

/** The app's skill freshness: the installer's own plan for every Orca skill present here. */
export async function scanBundledSkillFreshness(
  plan: BundledSkillPlanner
): Promise<SkillFreshnessInventory> {
  const plans = await plan(bundledOrcaSkillNames())
  return {
    schemaVersion: 2,
    skills: plans.filter((entry) => bundledSkillVerdict(entry) !== 'absent'),
    scannedAt: Date.now()
  }
}

/** Runs the plan for the names it calls an update; anything else is left as the plan said. */
export async function updateBundledSkills(
  names: readonly string[],
  deps: {
    plan: BundledSkillPlanner
    install: (names: string[]) => Promise<SkillInstallResult[]>
  }
): Promise<SkillInstallResult[]> {
  const updatable = (await deps.plan(names))
    .filter((entry) => bundledSkillVerdict(entry) === 'update')
    .map((entry) => entry.name)
  return updatable.length > 0 ? deps.install(updatable) : []
}

/** Names the re-plan after a run still has an update for — the run's per-skill verdict. */
export async function bundledSkillsStillToUpdate(
  names: readonly string[],
  plan: BundledSkillPlanner
): Promise<string[]> {
  return (await plan(names))
    .filter((entry) => bundledSkillVerdict(entry) === 'update')
    .map((entry) => entry.name)
}
