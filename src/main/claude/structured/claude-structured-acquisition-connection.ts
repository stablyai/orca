import { openClaudeStreamJsonConnection } from '../claude-stream-json-connection'
import type { ClaudeStreamJsonConnectionHandlers } from '../claude-stream-json-connection-types'
import { claudeConfigDirEnvPatch } from '../claude-config-dir-pin'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'
import { launchPreparationFailure } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type {
  ClaudeAcquisitionLaunch,
  ClaudeSessionAcquisitionInput
} from './launch/claude-structured-acquisition-launch'

export function openClaudeAcquisitionConnection({
  launch,
  input,
  deps,
  handlers,
  currentGeneration
}: Pick<ClaudeSessionAcquisitionInput, 'input' | 'deps'> & {
  launch: ClaudeAcquisitionLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  currentGeneration: () => string | null
}) {
  let onAdvisoryReport
  if (launch.advisoryPolicy) {
    try {
      if (!deps.prepareAdvisoryReporter) {
        throw new Error('Advisory report authority unavailable.')
      }
      onAdvisoryReport = deps.prepareAdvisoryReporter({
        sessionId: input.identity.sessionId,
        fence: input.fence,
        spawnToken: input.spawnToken,
        currentGeneration
      })
    } catch (error) {
      throw launchPreparationFailure(error)
    }
  }
  return withAgentSessionCreatePhase('spawn', input.recordPhase, () =>
    (deps.openConnection ?? openClaudeStreamJsonConnection)(
      {
        pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
        prefixArgs: launch.prefixArgs,
        options: launch.options,
        ...(launch.advisoryPolicy ? { advisoryPolicy: launch.advisoryPolicy } : {}),
        cwd: launch.cwd,
        env: {
          ...launch.env,
          // The pinned account must override a conflicting environment overlay.
          ...claudeConfigDirEnvPatch(launch.claudeConfigDir, { env: launch.env })
        },
        ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {})
      },
      { ...handlers, ...(onAdvisoryReport ? { onAdvisoryReport } : {}) }
    )
  )
}
