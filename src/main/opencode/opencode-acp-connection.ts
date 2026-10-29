import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import { AcpAgentConnection, type AcpAgentConnectionOptions } from '../acp/acp-agent-connection'
import { AcpAgentError, AcpAuthRequiredError, AcpSignInPromptError } from '../acp/acp-errors'
import type { AcpSessionStartOptions } from '../acp/acp-session-setup'
import type { PromptRequest } from '../acp/generated/acp-protocol.generated'
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
  return new OpenCodeAcpConnection(launch, options, spawnImpl, readFailure)
}

class OpenCodeAcpConnection extends AcpAgentConnection {
  private readonly dbPath: string | null
  private providerSessionId: string | undefined
  private lastRecoveredInput: string | undefined
  private prompting = false

  constructor(
    launch: ProviderProcessLaunch,
    options: AcpAgentConnectionOptions,
    spawnImpl: PipedProcessSpawner,
    private readonly readFailure: typeof readOpenCodePromptFailure
  ) {
    const env = resolveProviderChildEnv(launch, process.env)
    const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
    const selected = resolveOpenCodeDatabasePath(env, home)
    const dbPath = selected === null ? null : resolve(launch.cwd ?? process.cwd(), selected)
    super(launch, options, spawnImpl)
    this.dbPath = dbPath
  }

  override async start(options: AcpSessionStartOptions) {
    const started = await super.start(options)
    this.providerSessionId = started.sessionId
    return started
  }

  override async prompt(prompt: PromptRequest['prompt'], meta?: PromptRequest['_meta']) {
    if (this.prompting) {
      throw new Error('ACP prompt already in progress')
    }
    this.prompting = true
    const startedAt = Date.now()
    try {
      return await super.prompt(prompt, meta)
    } catch (error) {
      if (
        !(error instanceof AcpAgentError) ||
        error instanceof AcpSignInPromptError ||
        ![-32000, -32603].includes(error.code) ||
        !this.dbPath ||
        !this.providerSessionId ||
        this.closed
      ) {
        throw error
      }
      const failedAt = Date.now()
      let failure: OpenCodePromptFailure | null = null
      try {
        failure = (
          await this.readFailure({
            dbPath: this.dbPath,
            sessionId: this.providerSessionId,
            startedAt,
            failedAt
          })
        ).failure
      } catch {
        // Native history is best effort; never hide the ACP failure when it cannot be read.
      }
      if (!failure || this.closed || failure.inputId === this.lastRecoveredInput) {
        throw error
      }
      this.lastRecoveredInput = failure.inputId
      throw nativePromptError(failure, error)
    } finally {
      this.prompting = false
    }
  }
}
