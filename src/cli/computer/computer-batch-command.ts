import type {
  ComputerBatchResult,
  ComputerBatchStepResult
} from '../../shared/computer-use-batch-types'
import {
  COMPUTER_BATCH_MAX_STEPS,
  COMPUTER_BATCH_MAX_WAIT_MS,
  COMPUTER_BATCH_STOP_ON
} from '../../shared/rpc-contract/computer/computer-batch-params'
import type { CommandHandler } from '../dispatch/dispatch'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { getOptionalStringFlag } from '../arguments/flags'
import { readStdin } from '../arguments/flag-or-stdin-payload'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import { getComputerCommandTarget } from './computer-command-target'
import { getComputerActionObserveFlags } from './computer-action-flags'
import { formatGetAppState } from './computer-format'

// Why: each step may take up to the sidecar's 60 s request limit, so a fixed client timeout would cut long batches short.
const PER_STEP_CLIENT_TIMEOUT_MS = 60_000

export const runComputerBatch: CommandHandler = async ({ flags, client, cwd, json }) => {
  const steps = await getComputerBatchSteps(flags)
  const stopOn = getComputerBatchStopOn(flags)
  const { noScreenshot: _noScreenshot, ...observeFlags } = getComputerActionObserveFlags(flags)
  const target = await getComputerCommandTarget(flags, cwd, client)
  const waitMs = steps.reduce<number>(
    (total, step) => total + (isWaitStep(step) ? COMPUTER_BATCH_MAX_WAIT_MS : 0),
    0
  )
  let response: RuntimeRpcSuccess<ComputerBatchResult>
  try {
    response = await client.call<ComputerBatchResult>(
      'computer.batch',
      {
        ...target,
        ...observeFlags,
        // Screenshots are opt-in here: the batch exists to save turns and tokens.
        ...(flags.has('screenshot') ? {} : { noScreenshot: true }),
        ...(stopOn !== undefined ? { stopOn } : {}),
        steps
      },
      { timeoutMs: (steps.length + 1) * PER_STEP_CLIENT_TIMEOUT_MS + waitMs }
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'unsupported_capability',
        'This Orca runtime cannot run computer batch; update Orca, or run the steps as separate commands'
      )
    }
    throw error
  }
  printResult(response, json, (result) => formatComputerBatch(result, steps))
  if (response.result.batch.stoppedAt !== undefined || response.result.finalStateError) {
    process.exitCode = 1
  }
}

async function getComputerBatchSteps(flags: Map<string, string | boolean>): Promise<unknown[]> {
  const inline = getOptionalStringFlag(flags, 'steps')
  const fromStdin = flags.get('steps-stdin') === true
  if ((inline === undefined) === !fromStdin) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --steps <json> or --steps-stdin'
    )
  }
  const raw = inline ?? (await readStdin('steps'))
  let steps: unknown
  try {
    steps = JSON.parse(raw)
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      // Why: JSON.parse messages can quote nearby input, and steps may carry typed text or secrets.
      'Steps are not valid JSON; pass an array such as [{"command":"click","elementIndex":3}]'
    )
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > COMPUTER_BATCH_MAX_STEPS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Steps must be a JSON array of 1 to ${COMPUTER_BATCH_MAX_STEPS} objects such as [{"command":"click","elementIndex":3}]`
    )
  }
  return steps
}

function getComputerBatchStopOn(
  flags: Map<string, string | boolean>
): (typeof COMPUTER_BATCH_STOP_ON)[number] | undefined {
  const value = getOptionalStringFlag(flags, 'stop-on')
  if (value === undefined) {
    return undefined
  }
  const match = COMPUTER_BATCH_STOP_ON.find((option) => option === value)
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--stop-on must be ${COMPUTER_BATCH_STOP_ON.join(', ')}`
    )
  }
  return match
}

function isWaitStep(step: unknown): boolean {
  return isRecord(step) && step.command === 'wait'
}

export function formatComputerBatch(result: ComputerBatchResult, steps: unknown[]): string {
  const { batch } = result
  const headline =
    batch.stoppedAt === undefined
      ? `Batch ran ${batch.completed}/${batch.total} steps in ${batch.elapsedMs} ms.`
      : `Batch stopped at step ${batch.stoppedAt}/${batch.total} (${batch.stopReason === 'error' ? 'error' : `${batch.stopReason} result, --stop-on ${batch.stopOn}`}); later steps did not run.`
  const lines = [
    headline,
    ...result.steps.map((step) => `  ${formatComputerBatchStep(step, steps[step.step - 1])}`)
  ]
  const { snapshot, screenshot, screenshotStatus } = result
  if (snapshot && screenshotStatus) {
    lines.push(
      '',
      'State after the batch:',
      formatGetAppState({ snapshot, screenshot: screenshot ?? null, screenshotStatus })
    )
  } else if (result.finalStateError) {
    lines.push(
      '',
      `Could not read the state after the batch (${result.finalStateError.code}): ${result.finalStateError.message}`
    )
  }
  return lines.join('\n')
}

function formatComputerBatchStep(result: ComputerBatchStepResult, step: unknown): string {
  const label = `${result.step}. ${result.command}${formatComputerBatchStepTarget(step)}`
  if (result.error) {
    return `${label}: failed (${result.error.code}): ${result.error.message}`
  }
  const verification = result.verification
  if (!verification) {
    return result.command === 'wait' ? `${label}: done` : `${label}: ok, unverified`
  }
  const detail =
    verification.state === 'verified'
      ? `verified ${verification.property}`
      : `unverified (${verification.reason.replaceAll('_', ' ')})`
  const delivery = result.delivery === 'foreground' ? ', foreground' : ''
  return `${label}: ok, ${detail}${delivery}`
}

// Never echoes text or value: they can be secrets passed through --steps-stdin.
function formatComputerBatchStepTarget(step: unknown): string {
  if (!isRecord(step)) {
    return ''
  }
  const record = step
  const index = record.elementIndex ?? record['element-index']
  if (typeof index === 'number') {
    return ` #${index}`
  }
  if (typeof record.key === 'string') {
    return ` ${record.key}`
  }
  if (typeof record.ms === 'number') {
    return ` ${record.ms} ms`
  }
  if (typeof record.x === 'number' && typeof record.y === 'number') {
    return ` @ ${record.x},${record.y}`
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
