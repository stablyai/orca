import { Client as SshClient } from 'ssh2'
import type { ConnectConfig, KeyboardInteractiveCallback, Prompt } from 'ssh2'
import { CONNECT_TIMEOUT_MS, SSH_CREDENTIAL_TIMEOUT_MS } from './ssh-connection-timing'
import { createCancelledConnectAttemptError } from '../ssh-connect-attempt-cancellation'
import type { HostKeyVerificationError } from '../ssh-host-key-decision'

// Counts every INFO_REQUEST of the handshake, so it must cover each partial-success stage the auth
// queue will answer (MAX_PARTIAL_SUCCESS_STAGES) times the rounds a PAM stack spends per stage.
const SSH_KEYBOARD_INTERACTIVE_MAX_ROUNDS = 8
const SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS = SSH_CREDENTIAL_TIMEOUT_MS + 5_000

/** What one ssh2 handshake reads from and hands back to its connection. */
export type Ssh2HandshakeHost = {
  label: string
  pendingClients: Set<SshClient>
  /** Not disposed, and still the newest connect attempt. */
  isCurrentAttempt: () => boolean
  /** Still the newest connect attempt, whether or not the connection was disposed since. */
  isNewestGeneration: () => boolean
  isDisposed: () => boolean
  isKeyboardInteractiveCancelled: () => boolean
  answerKeyboardInteractive: (
    hostDetail: string,
    name: string,
    instructions: string,
    prompts: Prompt[],
    onPromptStart: () => void
  ) => Promise<string[] | null>
  hostKeyRejection: () => HostKeyVerificationError | null
  /** Takes ownership of the authenticated client before its startup listeners are removed. */
  adoptClient: (client: SshClient) => void
  onConnected: () => void
}

/** Dials `config` with ssh2 and settles once the session authenticates or fails. */
export function runSsh2Handshake(config: ConnectConfig, host: Ssh2HandshakeHost): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client = new SshClient()
    host.pendingClients.add(client)
    let settled = false
    let startupTimer: ReturnType<typeof setTimeout> | null = null
    let keyboardInteractiveRounds = 0
    let keyboardInteractiveAnswer: Promise<void> | null = null
    const clearStartupTimer = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
    }
    const rearmStartupTimer = (timeoutMs: number): void => {
      clearStartupTimer()
      startupTimer = setTimeout(() => {
        const error = new Error('Timed out while waiting for SSH authentication')
        Object.assign(error, { level: 'client-timeout' })
        onStartupError(error)
      }, timeoutMs)
    }

    const onKeyboardInteractive = (
      name: string,
      instructions: string,
      _instructionsLanguage: string,
      prompts: Prompt[],
      finish: KeyboardInteractiveCallback
    ): void => {
      keyboardInteractiveRounds += 1
      if (keyboardInteractiveRounds > SSH_KEYBOARD_INTERACTIVE_MAX_ROUNDS) {
        finish([])
        return
      }
      rearmStartupTimer(SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS)
      const answer = host
        .answerKeyboardInteractive(config.host || host.label, name, instructions, prompts, () =>
          rearmStartupTimer(SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS)
        )
        .then(
          (responses) => {
            // Settle cancellation immediately, but still answer ssh2’s pending callback.
            if (
              responses === null &&
              (!host.isNewestGeneration() || host.isKeyboardInteractiveCancelled())
            ) {
              finish([])
              if (!settled) {
                // Preserve the auth-failed state for explicit cancellation.
                const cancelledError = Object.assign(
                  new Error(`Keyboard-interactive authentication cancelled for ${host.label}`),
                  { level: 'client-authentication' }
                )
                failStartup(cancelledError)
              }
              return
            }
            const attemptIsCurrent = !settled && !host.isDisposed() && host.isNewestGeneration()
            finish(attemptIsCurrent ? (responses ?? []) : [])
          },
          () => finish([])
        )
      keyboardInteractiveAnswer = answer
      const forgetAnswer = (): void => {
        if (keyboardInteractiveAnswer === answer) {
          keyboardInteractiveAnswer = null
        }
      }
      void answer.then(forgetAnswer, forgetAnswer)
    }

    const cleanupStartupListeners = (): void => {
      client.off('ready', onReady)
      client.off('error', onStartupError)
      client.off('keyboard-interactive', onKeyboardInteractive)
      client.off('close', onStartupClose)
      host.pendingClients.delete(client)
      clearStartupTimer()
    }
    const swallowLateStartupError = (): void => {
      // Why: ssh2 can emit another socket error while destroying a settled pre-handshake client.
    }
    const guardStartupDestroy = (): void => {
      client.on('error', swallowLateStartupError)
    }

    const onReady = (): void => {
      if (settled) {
        return
      }
      // Why: connect() completion races with disconnect(); a late ready must not resurrect a torn-down client after generation/disposed changes.
      if (!host.isCurrentAttempt()) {
        settled = true
        guardStartupDestroy()
        cleanupStartupListeners()
        client.end()
        client.destroy()
        reject(createCancelledConnectAttemptError())
        return
      }
      settled = true
      host.adoptClient(client)
      cleanupStartupListeners()
      // Why: ssh2 leaves Nagle on; enable TCP_NODELAY so keystrokes don't stack with delayed-ACK (~40ms each). No-op for proxy sockets.
      client.setNoDelay(true)
      host.onConnected()
      resolve()
    }

    // Why: a host that drops an unanswered login (sshd LoginGraceTime) must not close the open
    // prompt for a retry that opens another; the user's answer decides, and a typed password is
    // cached for that retry.
    const onStartupError = (err: Error): void => {
      if (keyboardInteractiveAnswer && !settled) {
        const fail = (): void => failStartup(err)
        void keyboardInteractiveAnswer.then(fail, fail)
        return
      }
      failStartup(err)
    }

    const failStartup = (err: Error): void => {
      if (settled) {
        return
      }
      guardStartupDestroy()
      cleanupStartupListeners()
      settled = true
      client.destroy()
      // Why replace the error: ssh2 reports a denied host key as a generic handshake failure,
      // which the reconnect ladder cannot distinguish from a transient fault and would retry
      // forever against a decision that will never change.
      reject(host.hostKeyRejection() ?? err)
    }

    const onStartupClose = (): void => {
      if (settled) {
        return
      }
      const error = !host.isCurrentAttempt()
        ? createCancelledConnectAttemptError()
        : Object.assign(new Error('SSH connection closed during authentication'), {
            code: 'ECONNRESET'
          })
      onStartupError(error)
    }

    client.on('keyboard-interactive', onKeyboardInteractive)
    client.on('ready', onReady)
    client.on('error', onStartupError)
    client.on('close', onStartupClose)
    rearmStartupTimer(config.readyTimeout ?? CONNECT_TIMEOUT_MS)
    client.connect({ ...config, readyTimeout: 0 })
  })
}
