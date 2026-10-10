/**
 * Plain-Node process that owns one @cursor/sdk local agent.
 * Must not import electron: it is launched with ELECTRON_RUN_AS_NODE.
 */
import { createInterface } from 'node:readline'
import type { AgentOptions, LocalAgentOptions } from '@cursor/sdk'
import type * as CursorSdk from '@cursor/sdk'
import type { CursorSidecarCommand, CursorSidecarEvent } from './cursor-sdk-protocol'
import {
  cursorSdkRunResultFromStored,
  readCursorSdkRunUntilSettled,
  waitForStoredCursorRun,
  type CursorSdkRunResult,
  type CursorSdkStoredRun
} from './cursor-sdk-run-completion'
import {
  forwardCursorSdkDelta,
  forwardCursorSdkMessage,
  INITIAL_CURSOR_RUN_FORWARD_STATE,
  type CursorRunForwardState
} from './cursor-sdk-run-events'

type SdkModule = typeof CursorSdk
type LiveAgent = Awaited<ReturnType<SdkModule['Agent']['create']>>
type LiveRun = Awaited<ReturnType<LiveAgent['send']>>

let agent: LiveAgent | null = null
let run: LiveRun | null = null
let storedRuns: {
  get(input: {
    readonly agentId: string
    readonly runId: string
  }): Promise<CursorSdkStoredRun | null>
  list(input: {
    readonly filter?: { readonly agentIds?: readonly string[] }
  }): Promise<{ readonly items: readonly CursorSdkStoredRun[] }>
} | null = null
let disposing = false
let forward: CursorRunForwardState = INITIAL_CURSOR_RUN_FORWARD_STATE

function emitForward(next: { state: CursorRunForwardState; events: CursorSidecarEvent[] }): void {
  forward = next.state
  for (const event of next.events) {
    emit(event)
  }
}

function emit(event: CursorSidecarEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

async function loadSdk(): Promise<SdkModule> {
  return import('@cursor/sdk')
}

async function ensureSignedIn(sdk: SdkModule, apiKey: string | undefined): Promise<void> {
  if (apiKey) {
    return
  }
  const status = await sdk.Cursor.auth.status()
  if (status.status === 'logged-in') {
    return
  }
  await sdk.Cursor.auth.login({
    openBrowser: true,
    onLoginUrl: (url) => emit({ type: 'loginUrl', url })
  })
}

async function startAgent(
  sdk: SdkModule,
  command: Extract<CursorSidecarCommand, { type: 'start' }>
): Promise<void> {
  await ensureSignedIn(sdk, command.apiKey)
  const store = new sdk.JsonlLocalAgentStore(command.storeDir)
  storedRuns = store.runs
  const local: LocalAgentOptions = {
    cwd: command.cwd,
    store,
    settingSources: ['project', 'user', 'team', 'plugins'],
    sandboxOptions: { enabled: command.sandbox },
    autoReview: command.autoReview
  }
  const options: AgentOptions = {
    ...(command.apiKey ? { apiKey: command.apiKey } : {}),
    model: command.model,
    mode: command.mode,
    local
  }
  agent = command.agentId
    ? await sdk.Agent.resume(command.agentId, options)
    : await sdk.Agent.create(options)
  emit({ type: 'ready', agentId: agent.agentId })
}

function emitResult(result: CursorSdkRunResult): void {
  emit({
    type: 'result',
    status: resultStatus(result.status),
    ...(result.result ? { result: result.result } : {}),
    ...(result.error?.message ? { error: result.error.message } : {}),
    ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {})
  })
}

function resultStatus(status: string): 'finished' | 'error' | 'cancelled' {
  const normalized = status.toLowerCase()
  if (normalized === 'error' || normalized === 'cancelled') {
    return normalized
  }
  return 'finished'
}

async function readStoredRun(next: LiveRun): Promise<CursorSdkStoredRun | null> {
  return (await storedRuns?.get({ agentId: next.agentId, runId: next.id })) ?? null
}

async function consumeRun(next: LiveRun): Promise<void> {
  run = next
  try {
    const result = await readCursorSdkRunUntilSettled(
      next,
      (event) => {
        emitForward(forwardCursorSdkMessage(forward, event))
      },
      () => readStoredRun(next)
    )
    emitResult(result)
  } finally {
    if (run === next) {
      run = null
    }
  }
}

async function onSend(command: Extract<CursorSidecarCommand, { type: 'send' }>): Promise<void> {
  if (!agent) {
    throw new Error('Cursor agent is not started')
  }
  const message =
    command.images && command.images.length > 0
      ? { text: command.text, images: command.images }
      : command.text
  forward = INITIAL_CURSOR_RUN_FORWARD_STATE
  const current = agent
  const priorRunIds = new Set(
    (await listStoredRuns(current.agentId).catch(() => []))
      .map((row) => row.runId)
      .filter((runId): runId is string => typeof runId === 'string')
  )
  const sentAt = Date.now()
  let stopWatch = false
  const sending = current.send(message, {
    ...(command.model ? { model: command.model } : {}),
    ...(command.mode ? { mode: command.mode } : {}),
    onDelta: ({ update }) => {
      emitForward(forwardCursorSdkDelta(forward, update))
    }
  })
  try {
    const outcome = await Promise.race([
      sending.then((next) => ({ kind: 'run' as const, next })),
      waitForStoredCursorRun(
        () => listStoredRuns(current.agentId),
        sentAt,
        () => stopWatch,
        priorRunIds
      ).then((row) => ({ kind: 'store' as const, row }))
    ])
    if (outcome.kind === 'run') {
      await consumeRun(outcome.next)
      return
    }
    if (outcome.row) {
      emitResult(cursorSdkRunResultFromStored(outcome.row))
      // send can still reject after the stored row already finished the turn
      void sending.catch(() => {})
      return
    }
    await consumeRun(await sending)
  } finally {
    stopWatch = true
  }
}

async function listStoredRuns(agentId: string): Promise<CursorSdkStoredRun[]> {
  const listed = await storedRuns?.list({ filter: { agentIds: [agentId] } })
  return [...(listed?.items ?? [])]
}

function reportCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && 'code' in error ? String(error.code) : undefined
  if (!agent) {
    emit({ type: 'startupError', message, ...(code ? { code } : {}) })
    process.exitCode = 1
    return true
  }
  emit({ type: 'result', status: 'error', error: message })
  return false
}

async function handle(command: CursorSidecarCommand): Promise<void> {
  if (command.type === 'start') {
    const sdk = await loadSdk()
    await startAgent(sdk, command)
    return
  }
  if (command.type === 'send') {
    await onSend(command)
    return
  }
  if (command.type === 'steer') {
    const outcome = (await run?.steer?.(command.text)) ?? 'revert_to_followup'
    emit({ type: 'steer', id: command.id, outcome })
    return
  }
  if (command.type === 'cancel') {
    await run?.cancel()
    return
  }
  if (command.type === 'dispose') {
    disposing = true
    await agent?.[Symbol.asyncDispose]?.()
    agent = null
  }
}

function parseCommand(line: string): CursorSidecarCommand | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return null
  }
  const type = value.type
  if (
    type !== 'start' &&
    type !== 'send' &&
    type !== 'steer' &&
    type !== 'cancel' &&
    type !== 'dispose'
  ) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: type is one of the sidecar commands; the handler reads only the fields that command uses.
  return value as CursorSidecarCommand
}

async function main(): Promise<void> {
  if (process.argv[2] === 'models') {
    const sdk = await loadSdk()
    const models = await sdk.Cursor.models.list(
      process.env.CURSOR_API_KEY ? { apiKey: process.env.CURSOR_API_KEY } : {}
    )
    process.stdout.write(`${JSON.stringify({ models })}\n`)
    return
  }
  const lines = createInterface({ input: process.stdin })
  let inFlightSend: Promise<void> | null = null
  for await (const line of lines) {
    if (!line.trim() || disposing) {
      continue
    }
    const command = parseCommand(line)
    if (!command) {
      continue
    }
    // Why: send streams until the turn ends. Awaiting it here would leave steer and cancel unread.
    if (command.type === 'send') {
      inFlightSend = handle(command).catch((error: unknown) => {
        reportCommandError(error)
      })
      continue
    }
    try {
      await handle(command)
    } catch (error) {
      if (reportCommandError(error)) {
        break
      }
    }
    if (disposing) {
      break
    }
  }
  await inFlightSend
}

main()
  .catch((error: unknown) => {
    emit({
      type: 'startupError',
      message: error instanceof Error ? error.message : String(error)
    })
    process.exitCode = 1
  })
  .finally(() => {
    emit({ type: 'exited', code: typeof process.exitCode === 'number' ? process.exitCode : 0 })
  })
