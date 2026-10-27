import type { CodexModelCatalogProbeDeps } from '../codex/codex-model-catalog-probe'
import type { AcpStructuredSessionAdapterDeps } from '../acp/acp-structured-session-adapter-deps'
import type { AcpStructuredLaunchPartDeps } from '../acp/acp-structured-launch-resolution'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude/claude-structured-session-adapter'
import type { CodexStructuredSessionAdapterDeps } from '../codex/codex-structured-session-adapter'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import type { StructuredAgentSessionStartupLimits } from '../native-chat/agent-session-wire/structured-agent-session-startup-attempt-contract'
import type { PiRpcSessionDeps } from '../pi/rpc-session'
import type { PiRpcSessionAdapterDeps } from '../pi/rpc-session-adapter'

/** Provider transports are overridden only to drive the runtime against scripted children. */
export type StructuredAgentSessionTransportOverrides = {
  openPiConnection?: PiRpcSessionDeps['openConnection']
  /** Scripted Pi children resolve their launch here, so no test reaches a real Pi binary. */
  resolvePiLaunch?: PiRpcSessionAdapterDeps['resolveLaunch']
  openCodexConnection?: CodexStructuredSessionAdapterDeps['openConnection']
  /** Independent discovery uses its own short-lived transport, separate from chat children. */
  runCodexCatalogSession?: CodexModelCatalogProbeDeps['runSession']
  /** Scripted transports must also replace the real host's version probe. */
  readCodexInstallation?: AgentCliVersionReader
  openAcpConnection?: AcpStructuredSessionAdapterDeps['connect']
  /** Replace command lookup/version probing for scripted ACP children; unset uses the real binary. */
  acpLaunchCommand?: Pick<AcpStructuredLaunchPartDeps, 'resolveCommand' | 'probeVersion'>
  openClaudeConnection?: ClaudeStructuredSessionAdapterDeps['openConnection']
  /** Scripted app-servers carry fake pids the real start-time read cannot answer for. */
  readProcessStartTime?: CodexStructuredSessionAdapterDeps['readProcessStartTime']
  /** The shipped startup limits unless a test shortens them. */
  startupLimits?: Partial<StructuredAgentSessionStartupLimits>
}
