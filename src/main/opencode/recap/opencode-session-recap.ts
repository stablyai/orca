// `/recap`: a transient, read-only summary of an OpenCode session, shown as an Orca note. The
// provider's `session.generate` answers from the shared data dir, so a private `serve --stdio`
// child works whether or not its managed service or the chat's own server is running.

import { randomBytes, randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { environmentForStructuredOpenCodeAccountHome } from '../accounts/opencode-structured-account-home'
import { getManagedDataAccountService } from '../../managed-data-accounts/service'
import { createOpenCodeTextTaskHttp } from '../text-tasks/opencode-text-task-http'
import { waitForProcessExitUntil } from '../../provider-process/provider-process-exit-deadline'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { isLegacyAgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { AGENT_SESSION_RECAP_TIMEOUT_MS } from '../../../shared/agent-session/conversation-context/agent-session-recap-timeout'
import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import { writeStructuredAgentSessionOrcaNote } from '../../native-chat/agent-session-wire/structured-agent-session-orca-note'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'

// Verbatim from Claude Code's recap: matching its in-context ask keeps behavior aligned.
const RECAP_PROMPT =
  'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, ' +
  'no markdown. Lead with the overall goal and current task, then the one next action. Skip ' +
  'root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.'

const RECAP_MAX_CHARS = 400
const SERVER_READY_TIMEOUT_MS = 20_000
const SERVER_CLOSE_GRACE_MS = 1_500
const SERVER_LEASE_MAX_BYTES = 16_384

export class OpenCodeRecapError extends Error {}

function readGenerateText(value: unknown): string {
  const text =
    typeof value === 'object' && value !== null && 'text' in value ? value.text : undefined
  if (typeof text !== 'string' || text.length === 0) {
    throw new OpenCodeRecapError('OpenCode returned no recap')
  }
  return text.length > RECAP_MAX_CHARS ? text.slice(0, RECAP_MAX_CHARS) : text
}

function readServerUrl(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = ''
    let bytes = 0
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > SERVER_LEASE_MAX_BYTES) {
        reject(new OpenCodeRecapError('OpenCode server readiness exceeded its output limit'))
        return
      }
      const lines = (pending + chunk.toString('utf8')).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const url = JSON.parse(line)?.url
          if (typeof url === 'string' && url.startsWith('http')) {
            resolve(url)
            return
          }
        } catch {
          // Earlier lines are log output; the lease arrives as its own JSON line.
        }
      }
    }
    child.stdout?.on('data', onData)
    child.once('error', reject)
    child.once('close', () =>
      reject(new OpenCodeRecapError('OpenCode server exited before it was ready'))
    )
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function closeServer(child: ChildProcess, exited: Promise<void>): Promise<void> {
  try {
    child.stdin?.end()
  } catch {
    // A child that failed to spawn has no usable stdin; its close still settles below.
  }
  await waitForProcessExitUntil(exited, SERVER_CLOSE_GRACE_MS)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
  }
  // A killed child still owes its close; bound the reap so a wedged exit can't stall the request.
  await waitForProcessExitUntil(exited, SERVER_CLOSE_GRACE_MS)
}

function spawnServer(binary: string, env: NodeJS.ProcessEnv, signal: AbortSignal): ChildProcess {
  const child = spawnProcess({
    program: binary,
    args: ['serve', '--stdio', '--port', '0'],
    env,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  const kill = () => child.kill()
  signal.addEventListener('abort', kill, { once: true })
  child.once('close', () => signal.removeEventListener('abort', kill))
  return child
}

async function generateOnPrivateServer(input: {
  binaries: string[]
  env: NodeJS.ProcessEnv
  sessionId: string
  signal: AbortSignal
}): Promise<string> {
  const password = randomBytes(32).toString('base64url')
  const env = { ...input.env, OPENCODE_PASSWORD: password }
  let lastError: unknown
  for (const binary of input.binaries) {
    // The deadline covers the readiness read only; a ready child lives for the whole
    // generate below, so it is never wired to `ready`.
    const ready = AbortSignal.timeout(SERVER_READY_TIMEOUT_MS)
    const child = spawnServer(binary, env, input.signal)
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    // Any readiness failure (absent binary, timeout, early exit) tries the next binary.
    const url = await readServerUrl(child, AbortSignal.any([input.signal, ready])).catch(
      (error: unknown) => {
        lastError = error
        return null
      }
    )
    if (url === null) {
      await closeServer(child, exited)
      continue
    }
    try {
      // A running server owns the verdict now: a refused generate is the answer, not a reason
      // to try the next binary over the same data dir.
      return readGenerateText(
        await createOpenCodeTextTaskHttp(url, password, '', 'opencode', 'v2').request(
          'POST',
          `/api/session/${encodeURIComponent(input.sessionId)}/generate`,
          { prompt: RECAP_PROMPT },
          input.signal
        )
      )
    } finally {
      await closeServer(child, exited)
    }
  }
  throw lastError instanceof OpenCodeRecapError
    ? lastError
    : new OpenCodeRecapError('OpenCode could not start a server on this host', {
        cause: lastError
      })
}

/** Recaps one OpenCode chat into its journal; throws OpenCodeRecapError for anything refused. */
export async function recapStructuredOpenCodeSession(
  host: Pick<StructuredAgentSessionHost, 'deps' | 'conversation'>,
  sessionId: string
): Promise<{ text: string }> {
  const record = host.deps.store.getConversation(sessionId)
  if (!record) {
    throw new OpenCodeRecapError('This chat is no longer available')
  }
  if (record.provider !== 'opencode2' && record.provider !== 'opencode') {
    throw new OpenCodeRecapError('/recap is available for OpenCode chats')
  }
  // The provider's own name first; the sibling binary may be the same release under another alias.
  const binaries =
    record.provider === 'opencode2' ? ['opencode2', 'opencode'] : ['opencode', 'opencode2']
  const nativeId = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle.nativeId
  if (!nativeId) {
    throw new OpenCodeRecapError('Nothing to recap yet')
  }
  const accountHome = record.accountHome
  const env =
    accountHome === null || isLegacyAgentSessionAccountHome(accountHome)
      ? { ...process.env }
      : environmentForStructuredOpenCodeAccountHome(accountHome, {
          managedAccounts: getManagedDataAccountService(),
          baseEnvironment: process.env
        })
  // One deadline bounds generation, shutdown and the note append, so the request's own
  // timeout never fires over a stored note the caller was told failed.
  const deadline = AbortSignal.timeout(AGENT_SESSION_RECAP_TIMEOUT_MS - 6_000)
  const text = await generateOnPrivateServer({
    binaries,
    env,
    sessionId: nativeId,
    signal: deadline
  })
  // The append can't take the signal, so an abandoned wait reconciles its real settlement:
  // a note that stored anyway still reports success, a lost note reports its own error.
  const appended = writeStructuredAgentSessionOrcaNote(host, sessionId, `recap:${randomUUID()}`, {
    kind: 'status',
    text
  })
  try {
    await waitForPromiseWithSignal(appended, deadline)
  } catch (error) {
    if (!deadline.aborted) {
      throw error
    }
    await appended
  }
  return { text }
}
