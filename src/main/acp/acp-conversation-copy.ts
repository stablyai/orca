import { agentConversationCopyRefusal } from '../native-chat/agent-conversation-copy-error'
import type { StructuredAgentSessionConversationCopyInput } from '../native-chat/agent-session-wire/providers/structured-agent-session-conversation-copy-input'
import { readOpenCodeForkCoverageViaWorker } from '../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn'
import type { NativeCopyCoverage } from '../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import { observeAcpForkSupport } from './acp-fork-support'
import { normalizeAgentProviderSession } from '../../shared/agent-session/lifecycle/agent-session-resume'
import { OpenCodeCopyServerRouteError } from '../../shared/opencode-launch-command'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { AiVaultConversationCopy } from '../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { resolveOmpSessionsDir } from '../ai-vault/scanners/omp/omp-session-root'
import { AcpRpcError } from './acp-errors'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

class AcpCopyAccountMismatchError extends Error {
  constructor() {
    super('Select the account this chat uses before opening its copy in a CLI.')
  }
}

export const ACP_CONVERSATION_COPY_TIMEOUT_MS = 60_000

export async function copyAcpConversation(
  deps: Pick<
    AcpStructuredSessionAdapterDeps,
    'spec' | 'readLaunch' | 'resolveLaunchArgs' | 'connect' | 'logger' | 'dataDirectory'
  >,
  input: Pick<
    StructuredAgentSessionConversationCopyInput,
    'identity' | 'providerSessionId' | 'accountHome' | 'checkpoint'
  >,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    track: (connection: AcpStructuredConnection) => void
  }
): Promise<AiVaultConversationCopy & { coverage?: NativeCopyCoverage }> {
  const name = acpAgentName(deps.spec.agent)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? ACP_CONVERSATION_COPY_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  let connection: AcpStructuredConnection | null = null
  let result: AiVaultConversationCopy
  let launchEnv: Record<string, string>
  try {
    try {
      signal.throwIfAborted()
      deps.spec.assertCopyLaunchArgs?.(
        await waitForPromiseWithSignal(Promise.resolve(deps.resolveLaunchArgs?.() ?? []), signal)
      )
      signal.throwIfAborted()
      const launch = await waitForPromiseWithSignal(deps.readLaunch(input.identity), signal)
      launchEnv = launch.env
      signal.throwIfAborted()
      deps.spec.assertCopyLaunchArgs?.([], launch.prefixArgs)
      await assertCopyAccountSelected(deps, input.accountHome, launch.env, signal)
      signal.throwIfAborted()
      connection = deps.connect(
        {
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: launch.env,
          envToDelete: launch.envToDelete
        },
        { clientInfo: { name: 'orca', version: '1' } }
      )
      options.track(connection)
      const sessionId = await waitForPromiseWithSignal(
        forkAdvertised(connection, input.providerSessionId, launch.cwd, deps.spec.agent),
        signal
      )
      await assertCopyAccountSelected(deps, input.accountHome, launch.env, signal)
      const providerSession = normalizeAgentProviderSession({ key: 'session_id', id: sessionId })
      if (!providerSession || providerSession.id !== sessionId) {
        throw new Error('The agent returned an invalid copied conversation identity.')
      }
      if (sessionId === input.providerSessionId) {
        throw new Error('The agent returned the original conversation instead of a copy.')
      }
      const filePath =
        deps.spec.agent === 'omp'
          ? await resolveSessionFilePath(
              'omp',
              sessionId,
              {
                ompSessionsDir: resolveOmpSessionsDir({ env: launch.env })
              },
              signal
            )
          : undefined
      if (deps.spec.agent === 'omp' && !filePath) {
        throw new Error('OMP did not save the copied conversation in its pinned session directory.')
      }
      result = {
        sessionId,
        ...(filePath ? { filePath } : {})
      }
    } catch (error) {
      if (
        error instanceof AcpCopyAccountMismatchError ||
        error instanceof OpenCodeCopyServerRouteError
      ) {
        throw error
      }
      throw new Error(
        error instanceof AcpRpcError && error.code === -32601
          ? `This ${name} version cannot copy a chat. Update ${name} to resume this chat in a new CLI.`
          : `${name} could not copy this chat.`,
        { cause: error }
      )
    }
    if (input.checkpoint && (deps.spec.agent === 'opencode' || deps.spec.agent === 'opencode2')) {
      try {
        const dbPath = deps.spec.transcriptImport?.conversationStore({
          accountHome: input.accountHome,
          launchEnv
        })
        if (!dbPath) {
          throw new Error('OpenCode conversation store is unavailable')
        }
        const ids = await readOpenCodeForkCoverageViaWorker(
          {
            dbPath,
            sessionId: result.sessionId,
            sourceSessionId: input.providerSessionId
          },
          signal
        )
        return { ...result, coverage: { unit: 'acp-user-message', ids } }
      } catch (error) {
        options.signal?.throwIfAborted()
        deps.logger?.warn('OpenCode fork coverage read failed', {
          scope: 'acp-conversation-copy',
          sessionId: result.sessionId,
          error
        })
        throw agentConversationCopyRefusal(
          'agent_session_identity_required',
          { reason: 'transcriptUnreadable' },
          `${name} could not read the copied chat. Check that its conversation store is available, then try again.`
        )
      }
    }
    return result
  } finally {
    if (connection && !(await connection.close().catch(() => false))) {
      deps.logger?.warn('ACP conversation copy child exit is unproven; retained for cleanup', {
        scope: 'acp-conversation-copy',
        sessionId: input.identity.sessionId
      })
    }
  }
}

async function forkAdvertised(
  connection: AcpStructuredConnection,
  sessionId: string,
  cwd: string,
  agent: string
): Promise<string> {
  const initialized = await connection.initialize()
  observeAcpForkSupport(agent, initialized)
  const { agentCapabilities } = initialized
  if (agentCapabilities?.sessionCapabilities?.fork == null) {
    throw new AcpRpcError(-32601, 'session/fork is not advertised')
  }
  return connection.forkSession(sessionId, cwd)
}

/** Recheck the selected account at fork boundaries. */
async function assertCopyAccountSelected(
  { spec, dataDirectory }: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'dataDirectory'>,
  home: AgentSessionAccountHome,
  launchEnv: Record<string, string>,
  signal: AbortSignal
): Promise<void> {
  if ('kind' in home && home.kind === 'opencode') {
    const resolving = spec.account.resolve({ launchEnv, stateDirectory: dataDirectory })
    const selected = await waitForPromiseWithSignal(resolving, signal)
    if (!agentSessionAccountHomesEqual(home, selected)) {
      throw new AcpCopyAccountMismatchError()
    }
  }
}
