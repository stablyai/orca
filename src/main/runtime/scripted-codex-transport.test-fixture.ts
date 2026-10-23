import {
  CODEX_MINIMUM_SUPPORTED_VERSION,
  codexCliInstallation
} from '../../shared/codex-cli-installation'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

/** Runtime deps that put a scripted Codex child where the real app-server would spawn. It speaks
 *  the supported protocol, so it reports that version; its fake pid has a fixed start time. */
export function scriptedCodexTransport(
  openConnection: NonNullable<StructuredAgentSessionRuntimeDeps['openCodexConnection']>
): Pick<
  StructuredAgentSessionRuntimeDeps,
  'openCodexConnection' | 'readCodexInstallation' | 'readProcessStartTime'
> {
  return {
    openCodexConnection: openConnection,
    readCodexInstallation: async () => codexCliInstallation(true, CODEX_MINIMUM_SUPPORTED_VERSION),
    readProcessStartTime: async () => 1_700_000_000_000
  }
}
