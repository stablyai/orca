import type { CopilotSignInResult } from '../../shared/copilot-inline-completion-types'
import { isHttpsUrl, parseSignInResponse, type CopilotSignInResponse } from './copilot-protocol'
import type { CopilotServerConnection } from './copilot-server-connection'

// Why: the device flow resolves only after the user finishes in the browser.
const SIGN_IN_FINISH_TIMEOUT_MS = 10 * 60_000

export type CopilotSignInDeps = {
  openExternal: (url: string) => void
  copyToClipboard: (text: string) => void
  ensureConnection: () => Promise<CopilotServerConnection | null>
  refreshAuth: (connection: CopilotServerConnection) => Promise<void>
  currentUser: () => string | null
  /** Runs when the browser step failed, timed out, or ended without a signed-in user. */
  onFinishFailed: () => void
  /** Runs when a flow ends, so the owner can drop a server nothing else uses. */
  onSettled: () => void
}

/** Device-flow sign-in against the Copilot server; `isActive` gates server-initiated browser opens. */
export function createCopilotSignIn(deps: CopilotSignInDeps) {
  let inFlight = 0

  function settle(): void {
    inFlight--
    deps.onSettled()
  }

  /** Older servers return verificationUri and expect signInConfirm instead of a command. */
  function openAndConfirm(
    connection: CopilotServerConnection,
    response: CopilotSignInResponse
  ): Promise<unknown> {
    if (isHttpsUrl(response.verificationUri)) {
      deps.openExternal(response.verificationUri)
    }
    return connection.request(
      'signInConfirm',
      { userCode: response.userCode },
      SIGN_IN_FINISH_TIMEOUT_MS
    )
  }

  async function signIn(): Promise<CopilotSignInResult> {
    inFlight++
    let handedOffToFinish = false
    try {
      const connection = await deps.ensureConnection()
      if (!connection) {
        return { state: 'unavailable' }
      }
      const response = parseSignInResponse(await connection.request('signIn', {}))
      if (!response?.userCode) {
        await deps.refreshAuth(connection)
        return { state: 'alreadySignedIn', user: response?.user ?? deps.currentUser() }
      }
      deps.copyToClipboard(response.userCode)
      const finish = response.command
        ? connection.request(
            'workspace/executeCommand',
            { command: response.command.command, arguments: response.command.arguments ?? [] },
            SIGN_IN_FINISH_TIMEOUT_MS
          )
        : openAndConfirm(connection, response)
      handedOffToFinish = true
      // Why: the resulting login decides success; a timed-out finish request can still end signed in.
      const finished = (): void =>
        void deps
          .refreshAuth(connection)
          .finally(() => {
            if (!deps.currentUser()) {
              deps.onFinishFailed()
            }
          })
          .finally(settle)
      void finish.then(finished, finished)
      return {
        state: 'pending',
        userCode: response.userCode,
        verificationUri: response.verificationUri ?? null
      }
    } finally {
      if (!handedOffToFinish) {
        settle()
      }
    }
  }

  return { signIn, isActive: () => inFlight > 0 }
}
