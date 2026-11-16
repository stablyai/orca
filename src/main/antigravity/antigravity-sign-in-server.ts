import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { acpSessionStartMeta } from '../acp/launch/acp-session-meta'
import type { AcpAgentConnection, AcpSignInWatch } from '../acp/process/acp-agent-connection'
import type { ConnectAcpAgent } from '../acp/process/acp-structured-connection'
import { AcpAgentError, AcpSignInPromptError } from '../acp/transport/acp-errors'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { AntigravitySignInSentence, closeAntigravitySignInOwner } from './antigravity-chat-account'
import { SIGN_IN_FAILED, antigravitySignInFailure } from './antigravity-sign-in-failure'

const SESSION_FAILED =
  'Antigravity authenticated, but could not initialize a session or load models.'
const SAVED_SIGN_IN_UNUSABLE =
  "Google sign-in finished, but Antigravity can't use the saved sign-in. Start sign-in again and allow every permission Google asks for."

type SignInServerInput = {
  /** A new private temp folder per server: each server's exit removes its own. */
  connectServer: () => Promise<ConnectAcpAgent<AcpAgentConnection>>
  home: string
  launch: Parameters<ConnectAcpAgent<AcpAgentConnection>>[0] & { cwd: string }
  signal: AbortSignal
  closed: () => void
  /** Every server, so cleanup can wait for each one's exit. */
  spawned: (server: AcpAgentConnection) => void
}

/** Sign-in's server processes; each call returns only after its server's close is accepted. */
export function antigravitySignInServers({
  connectServer,
  home,
  launch,
  signal,
  closed,
  spawned
}: SignInServerInput) {
  const run = async <T>(
    watch: AcpSignInWatch,
    body: (server: AcpAgentConnection) => Promise<T>
  ): Promise<T> => {
    const connect = await connectServer()
    const server = connect(launch, { clientInfo: { name: 'orca', version: '1' }, signIn: watch })
    spawned(server)
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
    method: AntigravityChatAuthConfig['method'],
    // Before close, so a server whose exit is unproven still hands over its session's files.
    started: (sessionId: string) => void
  ) =>
    run({ read: spec.signIn.read, answered: spec.signIn.answered }, async (server) => {
      await server.initialize()
      closed()
      const session = await server
        .start({ cwd: launch.cwd, mcpServers: [], ...acpSessionStartMeta(spec) })
        .catch((error: unknown) => {
          const plain = error instanceof AcpAgentError && error.code === -32603
          throw plain && antigravitySignInFailure(error) === SIGN_IN_FAILED
            ? new AntigravitySignInSentence(SESSION_FAILED)
            : error
        })
      started(session.sessionId)
      return { started: session, live: !server.exited }
    }).catch(async (error: unknown) => {
      // Only the server asking for a browser sign-in proves the token unusable; other refusals keep
      // their own wording. An unusable token would still keep new chats off the host's own agy.
      if (!(error instanceof AcpSignInPromptError)) {
        throw error
      }
      // The server keeps each account type's sign-in in its own file.
      const token = method === 'oauth-business' ? 'acp_business_token.json' : 'acp_token.json'
      await rm(join(home, ANTIGRAVITY_ACP_HOME, token), { force: true })
      throw new AntigravitySignInSentence(SAVED_SIGN_IN_UNUSABLE, { cause: error })
    })

  return { run, startOnSavedSignIn }
}
