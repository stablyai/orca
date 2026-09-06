import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { getCodexConfigTomlPath, getSystemCodexConfigTomlPath } from './codex-hook-definition'

// Why (#16441): these sequences mutate the runtime config.toml *and* the
// system one — approval promotion, the system-config sync and the legacy sweep
// all touch ~/.codex/config.toml — so holding only the runtime lane still lets
// a real-home grant's capture->restore window swallow their writes. Lock order
// is always runtime-before-system; every other holder acquires it that way too.
export function runExclusivelyForRuntimeAndSystemTrustConfig<T>(
  runtimeHomePath: string,
  run: () => Promise<T>
): Promise<T> {
  return runExclusivelyForCodexTrustConfig(getCodexConfigTomlPath(runtimeHomePath), () =>
    runExclusivelyForCodexTrustConfig(getSystemCodexConfigTomlPath(), run)
  )
}
