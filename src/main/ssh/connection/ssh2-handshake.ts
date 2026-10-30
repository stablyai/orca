import type { Client as SshClient, ConnectConfig, KeyboardInteractiveCallback, Prompt } from 'ssh2'
import { loadSsh2 } from '../ssh2-module-load'
import { CONNECT_TIMEOUT_MS, SSH_CREDENTIAL_TIMEOUT_MS } from './ssh-connection-timing'
import { createCancelledConnectAttemptError } from '../ssh-connect-attempt-cancellation'
import type { HostKeyVerificationError } from '../ssh-host-key-decision'

// Count INFO_REQUEST across every partial-success stage and PAM challenge round.
const SSH_KEYBOARD_INTERACTIVE_MAX_ROUNDS = 8
const SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS = SSH_CREDENTIAL_TIMEOUT_MS + 5_000

/** What one ssh2 handshake reads from and hands back to its connection. */
type Ssh2HandshakeHost = {
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
    const client = new (loadSsh2().Client)()
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
      // Late ready cannot revive a disposed or superseded attempt.
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
      host.onConnected()
      resolve()
    }

    // LoginGraceTime drops must not close/reopen an active prompt; the user's answer is cached for retry.
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
      // Use the recorded denial; generic ssh2 handshake errors would retry a final trust refusal.
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
    // connect creates the socket synchronously; avoid delayed ACKs during key exchange and authentication too.
    client.setNoDelay(true)
  })
}
