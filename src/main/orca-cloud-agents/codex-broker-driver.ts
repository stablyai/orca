// Drives the Codex broker login (contract D11): start a broker, show its device code, poll until the
// control plane holds the ChatGPT login, then hand back. The login itself never touches this computer.
import type {
  CodexBrokerStart,
  CodexBrokerStatus,
  OrcaCloudAgentSetup
} from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  agentCredentialsFailureCode,
  type AgentCredentialsClient
} from './agent-credentials-client'

/** The broker's sign-in page must be OpenAI's; anything else is never shown or opened. */
export function isCodexSignInUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.hostname === 'openai.com' ||
      url.hostname.endsWith('.openai.com') ||
      url.hostname === 'chatgpt.com')
  )
}

export type CodexBrokerDriverDeps = {
  client: Pick<
    AgentCredentialsClient,
    'startCodexBroker' | 'codexBrokerStatus' | 'cancelCodexBroker'
  >
  onUpdate: (setup: OrcaCloudAgentSetup) => void
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  pollMs?: number
}

const POLL_MS = 3_000
// Whatever the broker says, a device code is never waited on for longer than this.
const MAX_WAIT_MS = 20 * 60_000
// A transient poll failure is retried; this many in a row ends the setup.
const MAX_POLL_FAILURES = 5
function isBrokerFailure(
  error: string
): error is 'not_a_chatgpt_login' | 'store_failed' | 'device_auth_disabled' {
  // RS-3: device-code sign-in turned off on the ChatGPT account gets its own words, not "couldn't save".
  return (
    error === 'not_a_chatgpt_login' || error === 'store_failed' || error === 'device_auth_disabled'
  )
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export type CodexBrokerSession = {
  /** Resolves when the setup ends (saved, failed or cancelled). */
  done: Promise<void>
  /** Stops polling and cancels the broker on the control plane. */
  cancel: () => Promise<void>
}

export function startCodexBrokerSession(deps: CodexBrokerDriverDeps): CodexBrokerSession {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const pollMs = deps.pollMs ?? POLL_MS
  const controller = new AbortController()
  let brokerId: string | null = null
  const startedAt = now()

  const run = async (): Promise<void> => {
    deps.onUpdate({ phase: 'preparing', startedAt })
    let started: CodexBrokerStart
    try {
      started = await deps.client.startCodexBroker()
    } catch (error) {
      if (!controller.signal.aborted) {
        deps.onUpdate({ phase: 'failed', error: agentCredentialsFailureCode(error) })
      }
      return
    }
    brokerId = started.brokerId
    if (controller.signal.aborted) {
      // Cancelled while the broker was starting: stop it too.
      await deps.client.cancelCodexBroker(started.brokerId).catch(() => undefined)
      return
    }
    if (!isCodexSignInUrl(started.verificationUrl)) {
      await deps.client.cancelCodexBroker(started.brokerId).catch(() => undefined)
      deps.onUpdate({ phase: 'failed', error: 'broker_unavailable' })
      return
    }
    const deadline = Math.min(started.expiresAt, startedAt + MAX_WAIT_MS)
    deps.onUpdate({
      phase: 'device',
      startedAt,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      expiresAt: deadline
    })
    let failures = 0
    while (!controller.signal.aborted) {
      await sleep(pollMs, controller.signal)
      if (controller.signal.aborted) {
        return
      }
      if (now() >= deadline) {
        await deps.client.cancelCodexBroker(started.brokerId).catch(() => undefined)
        deps.onUpdate({ phase: 'failed', error: 'code_expired' })
        return
      }
      let status: CodexBrokerStatus
      try {
        status = await deps.client.codexBrokerStatus(started.brokerId)
        failures = 0
      } catch (error) {
        failures += 1
        if (failures >= MAX_POLL_FAILURES && !controller.signal.aborted) {
          deps.onUpdate({ phase: 'failed', error: agentCredentialsFailureCode(error) })
          return
        }
        continue
      }
      if (controller.signal.aborted) {
        return
      }
      if (status.status === 'active') {
        deps.onUpdate({ phase: 'saved' })
        return
      }
      if (status.status === 'failed') {
        const error = status.error ?? ''
        deps.onUpdate(
          error === 'cancelled'
            ? { phase: 'idle' }
            : {
                phase: 'failed',
                error: isBrokerFailure(error) ? error : 'broker_unavailable'
              }
        )
        return
      }
    }
  }

  const done = run()
  return {
    done,
    cancel: async () => {
      if (controller.signal.aborted) {
        return
      }
      controller.abort()
      if (brokerId) {
        await deps.client.cancelCodexBroker(brokerId).catch(() => undefined)
      }
    }
  }
}
