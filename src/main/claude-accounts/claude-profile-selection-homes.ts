import type { ClaudeProfileRouter, ClaudeProfileRouterSettings } from './claude-profile-router'
import { claudeLaunchDestinationHome } from '../claude/claude-launch-destination-home'

/** Every native switcher destination, even an account whose setup has not created its home. */
export async function claudeProfileSelectionHomes(
  router: Pick<ClaudeProfileRouter, 'systemDefaultHome' | 'accountUsagePreparation'>,
  settings: Pick<ClaudeProfileRouterSettings, 'claudeManagedAccounts'>,
  environmentReady: Promise<unknown>,
  launchEnv: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  await environmentReady
  const system = router.systemDefaultHome()
  return [
    { provenance: 'system' as const, configDir: system },
    ...settings.claudeManagedAccounts
      .filter((account) => account.managedAuthRuntime !== 'wsl')
      .map((account) => router.accountUsagePreparation(account.id))
  ].map((preparation) => claudeLaunchDestinationHome(preparation, launchEnv, system))
}
