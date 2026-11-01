import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'

/** System provenance preserves the explicit agent overlay; managed provenance pins its own home. */
export function claudeLaunchDestinationHome(
  preparation: Pick<ClaudeRuntimeAuthPreparation, 'provenance' | 'configDir'>,
  launchEnv: NodeJS.ProcessEnv,
  systemDefaultHome: string
): string {
  return preparation.provenance === 'system'
    ? launchEnv.CLAUDE_CONFIG_DIR?.trim() || systemDefaultHome
    : preparation.configDir
}
