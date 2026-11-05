import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { getManagedCodexHookHome, readStopgapOrcaHashes } from './codex-hook-orca-approvals'
import { CODEX_ANSWER_AWAITED, readKnownCodexHookAnswer } from './codex-hook-hash-lookup'
import { installCodexHooksExclusively } from './codex-hook-local-install'
import { refreshCodexRuntimeUserHooksExclusively } from './codex-hook-local-maintenance'
import { readCodexHookHomeStatus, readCurrentCodexHookStatus } from './codex-hook-status'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from './codex-hook-trust-queue'

export function prepareCodexTextGenerationHooks(
  runtimeHomePath: string,
  isHooksEnabled: () => boolean,
  current: () => boolean
) {
  return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, async () => {
    if (!current()) {
      return null
    }
    const answer = readKnownCodexHookAnswer() ?? CODEX_ANSWER_AWAITED
    const status =
      !isHooksEnabled() || answer.kind === 'refused'
        ? await refreshCodexRuntimeUserHooksExclusively(runtimeHomePath, readCurrentCodexHookStatus)
        : await installCodexHooksExclusively(
            runtimeHomePath,
            answer.kind === 'hashes'
              ? answer.hashes
              : readStopgapOrcaHashes(
                  getManagedCodexHookHome(runtimeHomePath),
                  getManagedCommand(getManagedScriptPath())
                ),
            (home) => readCodexHookHomeStatus(home, answer)
          )
    return current() ? status : null
  })
}
