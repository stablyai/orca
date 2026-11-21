import type { GlobalSettings } from '../../../shared/settings/global-settings-types'

/** Kept out of command resolution so CLI-side detection can name it without the structured stack. */
export type StructuredAgentCommandSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultEnv' | 'antigravityManagedAgyEnabled'>
>
