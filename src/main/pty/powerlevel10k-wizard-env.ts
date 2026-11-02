export const POWERLEVEL10K_WIZARD_DISABLE_ENV = 'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'

export function seedPowerlevel10kWizardEnv(
  env: Record<string, string>,
  options: { envToDelete?: readonly string[] } = {}
): void {
  if (options.envToDelete?.includes(POWERLEVEL10K_WIZARD_DISABLE_ENV)) {
    return
  }
  // First-run p10k blocks queued commands; users can still run p10k configure manually.
  env[POWERLEVEL10K_WIZARD_DISABLE_ENV] ??= 'true'
}
