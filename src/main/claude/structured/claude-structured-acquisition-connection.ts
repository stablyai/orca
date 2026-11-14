import { openClaudeStreamJsonConnection } from '../claude-stream-json-connection'
import type {
  ClaudeStreamJsonConnectionHandlers,
  ClaudeStreamJsonConnection
} from '../claude-stream-json-connection-types'
import { claudeConfigDirEnvPatch } from './launch/claude-config-dir-pin'
import { withAgentSessionCreatePhase } from '../../observability/agent-session-instrumentation'
import { launchPreparationFailure } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { AgentSessionAdvisoryObservation } from '../../../shared/agent-session/agent-session-advisory-receipt'
import type {
  ClaudeAcquisitionLaunch,
  ClaudeSessionAcquisitionInput
} from './launch/claude-structured-acquisition-launch'

export async function openClaudeAcquisitionConnection({
  launch,
  input,
  deps,
  handlers,
  currentGeneration,
  receiptGeneration
}: Pick<ClaudeSessionAcquisitionInput, 'input' | 'deps'> & {
  launch: ClaudeAcquisitionLaunch
  handlers: ClaudeStreamJsonConnectionHandlers
  currentGeneration: () => string | null
  receiptGeneration: () => string | null
}) {
  let onAdvisoryReport
  let opened: ClaudeStreamJsonConnection | null = null
  let recordingFailed = false
  const onAdvisoryObservation = (observation: AgentSessionAdvisoryObservation) => {
    const generation = receiptGeneration()
    if (recordingFailed || !generation || !deps.onAdvisoryReceipt) {
      return
    }
    void deps
      .onAdvisoryReceipt({
        sessionId: input.identity.sessionId,
        fence: input.fence,
        generation,
        spawnToken: input.spawnToken,
        receipt: {
          ...observation,
          spawnTokenHash: createHash('sha256').update(input.spawnToken).digest('hex'),
          execution: {
            ...observation.execution,
            sessionId: input.identity.sessionId,
            runtimeFence: input.fence,
            acquisitionGeneration: generation
          }
        }
      })
      .catch(() => {
        recordingFailed = true
        handlers.onFault?.(new Error('Advisor receipt unavailable.'))
        void opened?.close({ grace: 'brief' })
      })
  }
  if (launch.advisoryPolicy) {
    try {
      if (!deps.prepareAdvisoryReporter) {
        throw new Error('Advisory report authority unavailable.')
      }
      if (launch.advisoryPolicy.schema === 2 && !deps.onAdvisoryReceipt) {
        throw new Error('Advisor receipt authority unavailable.')
      }
      onAdvisoryReport = deps.prepareAdvisoryReporter({
        sessionId: input.identity.sessionId,
        fence: input.fence,
        spawnToken: input.spawnToken,
        currentGeneration
      })
      if ((await readdir(launch.cwd)).length !== 0) {
        throw new Error('Advisory launch folder must be empty.')
      }
    } catch (error) {
      throw launchPreparationFailure(error)
    }
  }
  opened = await withAgentSessionCreatePhase('spawn', input.recordPhase, () =>
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
      {
        ...handlers,
        ...(onAdvisoryReport ? { onAdvisoryReport } : {}),
        ...(launch.advisoryPolicy?.schema === 2 ? { onAdvisoryObservation } : {})
      }
    )
  )
  return opened
}
