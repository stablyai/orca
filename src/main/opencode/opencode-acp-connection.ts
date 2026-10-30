import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import { AcpAgentConnection, type AcpAgentConnectionOptions } from '../acp/acp-agent-connection'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from '../acp/acp-errors'
import { readOpenCodePromptFailure } from '../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import type { OpenCodePromptFailure } from '../foreign-sqlite-readers/opencode-prompt-failure-result'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'
import { resolveOpenCodeDatabasePath } from './opencode-data-directory'

const ACCESS_REFUSALS = new Set(['FreeTierError', 'RegionError'])

function nativePromptError(failure: OpenCodePromptFailure, original: AcpAgentError): AcpAgentError {
  const access =
    failure.type === 'provider.auth' &&
    failure.status === 403 &&
    ACCESS_REFUSALS.has(failure.responseType ?? '')
  const errorName = access ? 'provider.access' : failure.type
  const message = (access ? failure.responseMessage : undefined) ?? failure.message
  const data = {
    ...(isRecord(original.data) ? original.data : {}),
    details: message,
    errorName,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.resetsAt === undefined ? {} : { resetsAt: failure.resetsAt })
  }
  return !access &&
    (failure.status === 401 || ['provider.auth', 'provider.authentication'].includes(errorName))
    ? new AcpAuthRequiredError(
        message,
        data,
        original instanceof AcpAuthRequiredError ? original.authMethods : undefined
      )
    : new AcpAgentError(-32603, message, data)
}

export function createOpenCodeAcpConnection(
  launch: ProviderProcessLaunch,
  options: AcpAgentConnectionOptions = {},
  spawnImpl: PipedProcessSpawner = spawnProcess,
  readFailure: typeof readOpenCodePromptFailure = readOpenCodePromptFailure
): AcpAgentConnection {
  const env = resolveProviderChildEnv(launch, process.env)
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  const selected = resolveOpenCodeDatabasePath(env, home)
  const dbPath = selected === null ? null : resolve(launch.cwd ?? process.cwd(), selected)
  let lastRecoveredInput: string | undefined
  return new AcpAgentConnection(
    launch,
    {
      ...options,
      normalizePromptError: (error, context) => {
        if (
          !(error instanceof AcpAgentError) ||
          error instanceof AcpSignInPromptError ||
          ![-32000, -32603].includes(error.code) ||
          !dbPath ||
          context.closed()
        ) {
          return error
        }
        const failedAt = Date.now()
        return readFailure({
          dbPath,
          sessionId: context.sessionId,
          startedAt: context.startedAt,
          failedAt
        }).then(
          ({ failure }) => {
            if (!failure || context.closed() || failure.inputId === lastRecoveredInput) {
              return error
            }
            lastRecoveredInput = failure.inputId
            return nativePromptError(failure, error)
          },
          () => error
        )
      }
    },
    spawnImpl
  )
}
