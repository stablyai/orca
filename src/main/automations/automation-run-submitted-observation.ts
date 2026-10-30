import { setTimeout as delay } from 'node:timers/promises'
import { subscribeNativeChatTranscript } from '../native-chat/transcript-watch'
import type { TranscriptRecordObservation } from '../native-chat/transcript-watch-contract'
import { stripTerminalControl } from '../../shared/terminal-control-stripping'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunSubmission
} from './automation-run-completion-contract'
import type { AutomationRun } from '../../shared/automations-types'
import type { AutomationRunTerminalHost } from './runtime-terminal-run-observer'
import { createAutomationRunNativeTurnDecoder } from './automation-run-native-turn-record'

const OBSERVE_DEADLINE_MS = 6 * 60 * 60 * 1000
const AGENT_START_POLL_INTERVAL_MS = 250
const AGENT_EVIDENCE_POLL_INTERVAL_MS = 1000
const sleep = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })

/** The source supplies accepted input and membership; Enter and status clocks never supply a turn. */
export async function observeSubmittedRun(
  runtime: AutomationRunTerminalHost,
  handle: string,
  run: AutomationRun,
  submission: AutomationRunSubmission,
  signal: AbortSignal
): Promise<AutomationRunCompletionObservation | null> {
  const readBinding = runtime.getTerminalPromptRequestBinding?.bind(runtime)
  const readRows = runtime.getAgentStatusRowsForPane?.bind(runtime)
  const observedIdentity = runtime.readObservedAgentStatusPaneIdentityFn?.bind(runtime)
  const decoder = createAutomationRunNativeTurnDecoder(submission.agent)
  if (!readBinding || !readRows || !observedIdentity || !decoder || !run.terminalPaneKey) {
    return null
  }
  const paneKey = run.terminalPaneKey
  let binding: ReturnType<typeof readBinding>
  try {
    binding = readBinding(handle)
  } catch {
    return null
  }
  if (run.terminalPtyId && binding.ptyId !== run.terminalPtyId) {
    return null
  }
  const deadlineAt = Date.now() + OBSERVE_DEADLINE_MS
  const processCurrent = (): boolean => {
    if (signal.aborted || submission.current?.() === false) {
      return false
    }
    try {
      const next = readBinding(handle)
      return next.ptyId === binding.ptyId && next.processIncarnation === binding.processIncarnation
    } catch {
      return false
    }
  }
  const readOwner = () => {
    const identity = observedIdentity(paneKey)
    if (
      identity.kind !== 'observed' ||
      identity.terminalHandle !== handle ||
      identity.processIncarnation !== binding.processIncarnation
    ) {
      return null
    }
    const row = readRows(paneKey)
      .filter((row) => !row.providerSessionOnly)
      .reduce<ReturnType<typeof readRows>[number] | null>(
        (latest, row) => (!latest || row.receivedAt > latest.receivedAt ? row : latest),
        null
      )
    return row &&
      !row.restoredUnconfirmed &&
      !row.isReplay &&
      row.agentType === submission.agent &&
      row.providerSession &&
      (!row.paneOwner ||
        (row.paneOwner.agent === submission.agent &&
          row.paneOwner.session === row.providerSession.id))
      ? row
      : null
  }
  let owner = readOwner()
  // Publication can precede SessionStart; this is observation, never launch admission.
  while (!owner && processCurrent() && Date.now() < deadlineAt) {
    await sleep(AGENT_START_POLL_INTERVAL_MS, signal)
    owner = readOwner()
  }
  if (!owner || !processCurrent()) {
    return null
  }
  if (owner.connectionId !== null) {
    return null
  }
  const session = owner.providerSession
  if (!session) {
    return null
  }
  const originalOwner = owner
  const sourceCurrent = (): boolean => {
    const row = readOwner()
    return Boolean(
      row &&
      row.connectionId === originalOwner.connectionId &&
      row.executionId === originalOwner.executionId &&
      row.providerSession?.id === session.id &&
      row.providerSession.key === session.key
    )
  }
  submission.sourceCurrent = sourceCurrent
  const current = (): boolean => processCurrent() && sourceCurrent()
  let unsubscribe = (): void => {}
  let resolveObservation: (value: AutomationRunCompletionObservation | null) => void = () => {}
  const completion = new Promise<AutomationRunCompletionObservation | null>((resolve) => {
    resolveObservation = resolve
  })
  const sourceAbort = new AbortController()
  const sourceSignal = AbortSignal.any([signal, sourceAbort.signal])
  let settled = false
  let cursor: { identity: string; offset: number } | null = null
  let baseline: { identity: string; offset: number } | null = null
  let identity: string | null = null
  let targetRoot: string | null = null
  let candidateId: string | null = null
  let legacyCodexRoot: string | null = null
  const roots = new Map<string, string>()
  const decodeRecord = decoder(session.id, roots)
  const output = new Map<string, ReturnType<typeof createHeadlessAutomationOutputSnapshotBuffer>>()
  const ended = new Map<string, AutomationRunCompletionObservation>()
  const finish = (value: AutomationRunCompletionObservation | null): void => {
    if (settled) {
      return
    }
    settled = true
    sourceAbort.abort()
    unsubscribe()
    submission.onSubmit = undefined
    roots.clear()
    output.clear()
    ended.clear()
    resolveObservation(value)
  }
  const submit = (): void => {
    baseline = cursor ? { ...cursor } : null
  }
  submission.onSubmit = submit
  // A late initial read is not a pre-Enter cursor. Replay cannot assign an old equal prompt to this send.
  if (submission.submitted) {
    baseline = null
  }
  const accept = (id: string, root: string, text: string, offset: number): void => {
    if (
      !submission.submitted ||
      !baseline ||
      baseline.identity !== identity ||
      offset < baseline.offset ||
      text !== submission.prompt
    ) {
      return
    }
    if (candidateId && candidateId !== id) {
      return finish(null)
    }
    if (!candidateId) {
      output.delete(root)
    }
    candidateId = id
    targetRoot = root
  }
  const record = (event: TranscriptRecordObservation): void => {
    if (settled) {
      return
    }
    if (!current()) {
      return finish(null)
    }
    if (event.kind === 'gap') {
      return finish(null)
    }
    if (event.kind === 'reset') {
      if (identity !== null) {
        return finish(null)
      }
      identity = event.identity
      return
    }
    if (event.identity !== identity) {
      return finish(null)
    }
    if (event.kind === 'read-start') {
      if (!submission.submitted) {
        cursor = { identity: event.identity, offset: event.offset }
      }
      return
    }
    if (event.kind === 'caught-up') {
      cursor = { identity: event.identity, offset: event.offset }
      if (submission.submitted && !baseline) {
        return finish(null)
      }
      if (targetRoot && ended.has(targetRoot)) {
        finish(ended.get(targetRoot) ?? null)
      }
      return
    }
    const decoded = decodeRecord(event, legacyCodexRoot)
    if (!decoded) {
      return
    }
    if ('invalid' in decoded) {
      return finish(null)
    }
    const { root, inputId, committed, error, message, state, provider } = decoded
    legacyCodexRoot = decoded.legacyCodexRoot
    if (!root) {
      return
    }
    if (
      committed &&
      inputId &&
      message?.role === 'user' &&
      message.blocks.every((block) => block.type === 'text')
    ) {
      accept(
        inputId,
        root,
        message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
        event.offset
      )
    }
    if (message?.role === 'assistant') {
      const text = message.blocks
        .flatMap((block) => (block.type === 'text' ? [stripTerminalControl(block.text)] : []))
        .join('\n')
      if (text) {
        let buffer = output.get(root)
        if (!buffer) {
          buffer = createHeadlessAutomationOutputSnapshotBuffer()
          output.set(root, buffer)
        }
        buffer.append(`${text}\n`)
      }
    }
    if (error || (state && state.state !== 'working')) {
      const interrupted = state?.state === 'interrupted'
      ended.set(root, {
        status: interrupted || error ? 'dispatch_failed' : 'completed',
        error:
          error ?? (interrupted ? 'The agent was interrupted before this turn completed.' : null),
        outputSnapshot: output.get(root)?.snapshot() ?? null
      })
      if (root !== targetRoot) {
        output.delete(root)
        ended.delete(root)
        for (const [id, generation] of roots) {
          if (generation === root) {
            roots.delete(id)
          }
        }
      }
      if (provider === 'codex') {
        legacyCodexRoot = null
      }
    }
  }
  const abort = () => finish(null)
  signal.addEventListener('abort', abort, { once: true })
  // Existing six-hour resource bound is not an end-of-turn guess.
  const deadline = setTimeout(() => finish(null), Math.max(0, deadlineAt - Date.now()))
  deadline.unref?.()
  try {
    const subscription = await subscribeNativeChatTranscript(
      {
        agent: submission.agent,
        sessionId: session.id,
        transcriptPath: session.transcriptPath,
        sourceOrder: true,
        onAppend: () => {},
        onRecord: record
      },
      sourceSignal
    )
    unsubscribe = subscription.unsubscribe
    if (settled || !current() || !subscription.watching) {
      finish(null)
    } else {
      while (!settled && current() && Date.now() < deadlineAt) {
        await Promise.race([completion, sleep(AGENT_EVIDENCE_POLL_INTERVAL_MS, signal)])
      }
      if (!settled) {
        finish(null)
      }
    }
    return await completion
  } catch (error) {
    if (!settled) {
      throw error
    }
    return await completion
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    finish(null)
    unsubscribe()
  }
}
