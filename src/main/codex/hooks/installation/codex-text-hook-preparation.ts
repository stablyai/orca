import { getManagedScriptPath } from '../definitions/codex-hook-definition'
import { buildCodexHookCommand as getManagedCommand } from '../definitions/codex-hook-command-form'
import {
  getManagedCodexHookHome,
  readStopgapOrcaHashes
} from '../../trust/hooks/codex-hook-orca-approvals'
import {
  CODEX_ANSWER_AWAITED,
  readKnownCodexHookAnswer
} from '../../trust/hooks/codex-hook-hash-lookup'
import { installCodexHooksExclusively } from './codex-hook-local-install'
import { refreshCodexRuntimeUserHooksExclusively } from './codex-hook-local-maintenance'
import {
  readCodexHookHomeStatus,
  readCurrentCodexHookStatus
} from '../reconciliation/codex-hook-status'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from '../../trust/hooks/codex-hook-trust-queue'

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
