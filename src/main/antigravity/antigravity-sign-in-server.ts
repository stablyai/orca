import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { acpSessionStartMeta } from '../acp/launch/acp-session-meta'
import type { AcpAgentConnection, AcpSignInWatch } from '../acp/process/acp-agent-connection'
import type { ConnectAcpAgent } from '../acp/process/acp-structured-connection'
import { AcpAgentError, AcpAuthRequiredError } from '../acp/transport/acp-errors'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/antigravity-session-origin'
import { AntigravitySignInSentence, closeAntigravitySignInOwner } from './antigravity-chat-account'
import { SIGN_IN_FAILED, antigravitySignInFailure } from './antigravity-sign-in-failure'

const SESSION_FAILED =
  'Antigravity authenticated, but could not initialize a session or load models.'
const SAVED_SIGN_IN_UNUSABLE =
  "Google sign-in finished, but Antigravity can't use the saved sign-in. Start sign-in again and allow every permission Google asks for."

type SignInServerInput = {
  connect: ConnectAcpAgent<AcpAgentConnection>
  home: string
  launch: Parameters<ConnectAcpAgent<AcpAgentConnection>>[0] & { cwd: string }
  signal: AbortSignal
  closed: () => void
}

/** Sign-in's server processes; each call returns only once its server's exit is proven. */
export function antigravitySignInServers({
  connect,
  home,
  launch,
  signal,
  closed
}: SignInServerInput) {
  const run = async <T>(
    watch: AcpSignInWatch,
    body: (server: AcpAgentConnection) => Promise<T>
  ): Promise<T> => {
    const server = connect(launch, { clientInfo: { name: 'orca', version: '1' }, signIn: watch })
    const stop = (): void => void server.close().catch(() => false)
    signal.addEventListener('abort', stop, { once: true })
    try {
      return await body(server)
    } finally {
      signal.removeEventListener('abort', stop)
      await closeAntigravitySignInOwner(home, server)
    }
  }

  // Only a server holding just the saved sign-in proves later chats can use it: Google can grant
  // fewer scopes than requested, and the server then saves a token it can never refresh.
  const startOnSavedSignIn = (
    spec: AcpLaunchSpec & { signIn: AcpSignInWatch },
    spawned: (server: AcpAgentConnection) => void
  ) =>
    run({ read: spec.signIn.read, answered: spec.signIn.answered }, async (server) => {
      spawned(server)
      await server.initialize()
      closed()
      const started = await server
        .start({ cwd: launch.cwd, mcpServers: [], ...acpSessionStartMeta(spec) })
        .catch((error: unknown) => {
          const plain = error instanceof AcpAgentError && error.code === -32603
          throw plain && antigravitySignInFailure(error) === SIGN_IN_FAILED
            ? new AntigravitySignInSentence(SESSION_FAILED)
            : error
        })
      return { started, live: !server.exited }
    }).catch(async (error: unknown) => {
      if (!(error instanceof AcpAuthRequiredError)) {
        throw error
      }
      // An unusable token would still keep new chats off the host's own agy.
      await rm(join(home, ANTIGRAVITY_ACP_HOME, 'acp_token.json'), { force: true })
      throw new AntigravitySignInSentence(SAVED_SIGN_IN_UNUSABLE, { cause: error })
    })

  return { run, startOnSavedSignIn }
}
