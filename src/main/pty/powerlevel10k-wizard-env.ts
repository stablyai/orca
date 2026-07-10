export const POWERLEVEL10K_WIZARD_DISABLE_ENV = 'POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD'

export function seedPowerlevel10kWizardEnv(
  env: Record<string, string>,
  options: { envToDelete?: readonly string[] } = {}
): void {
  if (options.envToDelete?.includes(POWERLEVEL10K_WIZARD_DISABLE_ENV)) {
    return
  }
  // Why: p10k's first-run wizard blocks shell startup and queued commands.
  // Users can still run `p10k configure` manually inside an Orca terminal.
  env[POWERLEVEL10K_WIZARD_DISABLE_ENV] ??= 'true'
}
