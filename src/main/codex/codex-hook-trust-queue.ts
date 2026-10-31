import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { getCodexConfigTomlPath, getSystemCodexConfigTomlPath } from './codex-hook-definition'

// Promotion, config sync and legacy cleanup mutate both homes; hold both lanes across awaits.
// Always acquire runtime before system to preserve lock order.
export function runExclusivelyForRuntimeAndSystemTrustConfig<T>(
  runtimeHomePath: string,
  run: () => Promise<T>
): Promise<T> {
  return runExclusivelyForCodexTrustConfig(getCodexConfigTomlPath(runtimeHomePath), () =>
    runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), run)
  )
}
