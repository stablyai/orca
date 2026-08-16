import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import type {
  SkillFreshnessInventory,
  SkillUpdateRun,
  SkillUpdateStartResult
} from '../../shared/skill-freshness'

export type SkillsApi = {
  discover: (target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>
  freshnessInventory: () => Promise<SkillFreshnessInventory>
  startUpdateRun: (names: string[]) => Promise<SkillUpdateStartResult>
  cancelUpdateRun: () => Promise<void>
  acknowledgeUpdateRun: () => Promise<void>
  getUpdateRun: () => Promise<SkillUpdateRun>
  onUpdateRun: (callback: (run: SkillUpdateRun) => void) => () => void
}
