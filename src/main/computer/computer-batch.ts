import type { ZodType } from 'zod'
import type {
  ComputerActionResult,
  ComputerActionVerification,
  ComputerSnapshotResult
} from '../../shared/computer-use-runtime-types'
import type {
  ComputerBatchResult,
  ComputerBatchStepResult,
  ComputerBatchStopOn
} from '../../shared/computer-use-batch-types'
import {
  COMPUTER_BATCH_MAX_WAIT_MS,
  type ComputerBatchParams
} from '../../shared/rpc-contract/computer/computer-batch-params'
import {
  Click,
  Drag,
  Hotkey,
  PasteText,
  PerformSecondaryAction,
  PressKey,
  Scroll,
  SetValue,
  TypeText
} from '../../shared/rpc-contract/computer/computer-schemas-params'
import type { ComputerSidecarActionMethod } from './sidecar-transport/sidecar-client'
import { RuntimeClientError } from './runtime-client-error'
import { validateBatchPasteSteps } from './computer-batch-paste-validation'

export type ComputerBatchDeps = {
  runAction: (
    method: ComputerSidecarActionMethod,
    params: Record<string, unknown>
  ) => Promise<ComputerActionResult>
  getAppState: (params: Record<string, unknown>) => Promise<ComputerSnapshotResult>
  sleep: (ms: number) => Promise<void>
}

type StepSpec = {
  method: ComputerSidecarActionMethod
  schema: ZodType<Record<string, unknown>>
  fields: string[]
}

// Step fields are the command's own flags in camelCase; targeting is set once for the whole batch.
const STEP_SPECS: Record<string, StepSpec> = {
  click: {
    method: 'click',
    schema: Click,
    fields: ['elementIndex', 'x', 'y', 'clickCount', 'mouseButton', 'modifiers']
  },
  'perform-secondary-action': {
    method: 'performSecondaryAction',
    schema: PerformSecondaryAction,
    fields: ['elementIndex', 'action']
  },
  scroll: {
    method: 'scroll',
    schema: Scroll,
    fields: ['elementIndex', 'x', 'y', 'direction', 'pages']
  },
  drag: {
    method: 'drag',
    schema: Drag,
    fields: ['fromElementIndex', 'toElementIndex', 'fromX', 'fromY', 'toX', 'toY']
  },
  'type-text': { method: 'typeText', schema: TypeText, fields: ['elementIndex', 'text'] },
  'press-key': { method: 'pressKey', schema: PressKey, fields: ['key', 'allowSystemShortcut'] },
  hotkey: { method: 'hotkey', schema: Hotkey, fields: ['key', 'allowSystemShortcut'] },
  'paste-text': { method: 'pasteText', schema: PasteText, fields: ['text'] },
  'set-value': { method: 'setValue', schema: SetValue, fields: ['elementIndex', 'value'] }
}

const BATCH_LEVEL_FIELDS = new Set([
  'app',
  'session',
  'worktree',
  'windowId',
  'windowIndex',
  'restoreWindow',
  'noScreenshot',
  'screenshotFormat',
  'screenshotScale',
  'screenshotMaxEdge',
  'treeDiff'
])

// Results that suggest the step did not do what it should, so later steps would build on a wrong state.
const SUSPECT_REASONS = new Set(['suspected_noop', 'text_mismatch', 'window_changed'])

export type ParsedStep =
  | { kind: 'wait'; command: 'wait'; ms: number }
  | {
      kind: 'action'
      command: string
      method: ComputerSidecarActionMethod
      params: Record<string, unknown>
    }

export async function runComputerBatch(
  params: ComputerBatchParams,
  deps: ComputerBatchDeps
): Promise<ComputerBatchResult> {
  const startedAt = Date.now()
  const stopOn = params.stopOn ?? 'suspect'
  const target = {
    app: params.app,
    ...(params.session !== undefined ? { session: params.session } : {}),
    ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
    ...(params.windowId !== undefined ? { windowId: params.windowId } : {}),
    ...(params.windowIndex !== undefined ? { windowIndex: params.windowIndex } : {})
  }
  const stepTarget = {
    ...target,
    ...(params.restoreWindow === true ? { restoreWindow: true } : {})
  }
  // Why: check every step before the first one runs, so a typo in step 5 cannot leave steps 1-4 applied.
  const steps = params.steps.map((raw, index) => parseComputerBatchStep(raw, index + 1, stepTarget))
  await validateBatchPasteSteps(steps)

  const results: ComputerBatchStepResult[] = []
  let stop: { step: number; reason: ComputerBatchStopOn } | undefined
  let windowChanged = false
  for (const [index, step] of steps.entries()) {
    const stepStartedAt = Date.now()
    const number = index + 1
    if (step.kind === 'wait') {
      await deps.sleep(step.ms)
      results.push({
        step: number,
        command: 'wait',
        ok: true,
        elapsedMs: Date.now() - stepStartedAt
      })
      continue
    }
    try {
      const { action } = await deps.runAction(step.method, step.params)
      const verification = action?.verification
      results.push({
        step: number,
        command: step.command,
        ok: true,
        elapsedMs: Date.now() - stepStartedAt,
        ...(action?.path ? { path: action.path } : {}),
        ...(action?.delivery ? { delivery: action.delivery } : {}),
        ...(verification ? { verification } : {})
      })
      windowChanged ||= isUnverifiedFor(verification, 'window_changed')
      const reason = verificationStopReason(verification, stopOn)
      if (reason) {
        stop = { step: number, reason }
        break
      }
    } catch (error) {
      results.push({
        step: number,
        command: step.command,
        ok: false,
        elapsedMs: Date.now() - stepStartedAt,
        error: errorSummary(error)
      })
      stop = { step: number, reason: 'error' }
      break
    }
  }

  const batch = {
    total: steps.length,
    completed: results.filter((result) => result.ok).length,
    stopOn,
    ...(stop ? { stoppedAt: stop.step, stopReason: stop.reason } : {})
  }
  const { windowId: _windowId, windowIndex: _windowIndex, ...appTarget } = target
  try {
    // One read after the last step; intermediate steps kept the tree baseline, so this diffs the whole batch.
    const state = await deps.getAppState({
      ...(windowChanged ? appTarget : target),
      ...(params.noScreenshot === true ? { noScreenshot: true } : {}),
      ...(params.screenshotFormat !== undefined
        ? { screenshotFormat: params.screenshotFormat }
        : {}),
      ...(params.screenshotScale !== undefined ? { screenshotScale: params.screenshotScale } : {}),
      ...(params.screenshotMaxEdge !== undefined
        ? { screenshotMaxEdge: params.screenshotMaxEdge }
        : {}),
      ...(params.treeDiff === true ? { treeDiff: true } : {}),
      // Why: a long batch can outlive the baseline's normal lifetime; the baseline from before it still applies.
      treeBaselineGraceMs: Date.now() - startedAt
    })
    return { ...state, steps: results, batch: { ...batch, elapsedMs: Date.now() - startedAt } }
  } catch (error) {
    return {
      steps: results,
      batch: { ...batch, elapsedMs: Date.now() - startedAt },
      finalStateError: errorSummary(error)
    }
  }
}

function parseComputerBatchStep(
  raw: unknown,
  number: number,
  target: Record<string, unknown>
): ParsedStep {
  if (!isRecord(raw)) {
    throw invalidStep(number, 'must be an object such as {"command":"click","elementIndex":3}')
  }
  const fields = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [camelCase(key), value])
  )
  const { command, ...rest } = fields
  if (command === 'wait') {
    return parseWaitStep(rest, number)
  }
  const spec = typeof command === 'string' ? STEP_SPECS[command] : undefined
  if (!spec || typeof command !== 'string') {
    throw invalidStep(
      number,
      `unknown command ${JSON.stringify(command)}; use one of ${[...Object.keys(STEP_SPECS), 'wait'].join(', ')}`
    )
  }
  const name = command
  for (const key of Object.keys(rest)) {
    if (BATCH_LEVEL_FIELDS.has(key)) {
      throw invalidStep(number, `${key} applies to the whole batch; pass it as a batch flag`)
    }
    if (!spec.fields.includes(key)) {
      throw invalidStep(number, `${name} has no field "${key}"; use ${spec.fields.join(', ')}`)
    }
  }
  const parsed = spec.schema.safeParse({ ...target, ...rest })
  if (!parsed.success) {
    throw invalidStep(number, `${name}: ${parsed.error.issues[0]?.message ?? 'invalid step'}`)
  }
  return {
    kind: 'action',
    command: name,
    method: spec.method,
    // Why: intermediate trees are never shown, so skip their screenshots and keep the pre-batch diff baseline.
    params: {
      ...parsed.data,
      noScreenshot: true,
      keepTreeBaseline: true
    }
  }
}

function parseWaitStep(fields: Record<string, unknown>, number: number): ParsedStep {
  const extra = Object.keys(fields).filter((key) => key !== 'ms')
  if (extra.length > 0) {
    throw invalidStep(number, `wait has no field "${extra[0]}"; use ms`)
  }
  const { ms } = fields
  if (
    typeof ms !== 'number' ||
    !Number.isInteger(ms) ||
    ms <= 0 ||
    ms > COMPUTER_BATCH_MAX_WAIT_MS
  ) {
    throw invalidStep(
      number,
      `wait needs ms, a whole number of milliseconds from 1 to ${COMPUTER_BATCH_MAX_WAIT_MS}`
    )
  }
  return { kind: 'wait', command: 'wait', ms }
}

function verificationStopReason(
  verification: ComputerActionVerification | undefined,
  stopOn: ComputerBatchStopOn
): ComputerBatchStopOn | null {
  if (stopOn === 'error' || verification?.state === 'verified') {
    return null
  }
  if (stopOn === 'unverified') {
    return 'unverified'
  }
  return verification && SUSPECT_REASONS.has(verification.reason) ? 'suspect' : null
}

function isUnverifiedFor(
  verification: ComputerActionVerification | undefined,
  reason: string
): boolean {
  return verification?.state === 'unverified' && verification.reason === reason
}

function camelCase(key: string): string {
  return key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

function invalidStep(number: number, message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', `Batch step ${number}: ${message}`)
}

function errorSummary(error: unknown): { code: string; message: string } {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (error instanceof Error && typeof code === 'string') {
    return { code, message: error.message }
  }
  return {
    code: 'accessibility_error',
    message: error instanceof Error ? error.message : String(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
