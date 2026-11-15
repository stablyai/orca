import {
  COMPUTER_WAIT_DEFAULT_TIMEOUT_MS,
  COMPUTER_WAIT_MAX_TIMEOUT_MS
} from '../../shared/computer-wait-timeout'
import {
  formatComputerWaitSnapshot,
  formatComputerWaitWindows,
  waitForComputerSnapshot,
  waitForComputerWindowTitle,
  type ComputerWaitCondition
} from './computer-wait'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { getComputerCommandTarget } from './computer-command-target'
import { getComputerWindowTargetFlags } from './computer-action-flags'

export const runComputerWait: CommandHandler = async ({ flags, client, cwd, json }) => {
  const condition = getComputerWaitCondition(flags)
  const timeoutMs = getComputerWaitTimeoutMs(flags)
  const windowTarget = getComputerWindowTargetFlags(flags)
  if (condition.kind === 'window-title') {
    if (Object.keys(windowTarget).length > 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        "--window-title waits across all of the app's windows; drop --window-id and --window-index"
      )
    }
    const app = getRequiredStringFlag(flags, 'app')
    const result = await waitForComputerWindowTitle(client, condition, app, timeoutMs)
    printResult(result, json, formatComputerWaitWindows)
    return
  }
  const target = await getComputerCommandTarget(flags, cwd, client)
  const result = await waitForComputerSnapshot(
    client,
    condition,
    { ...target, ...windowTarget },
    timeoutMs
  )
  printResult(result, json, formatComputerWaitSnapshot)
}

function getComputerWaitCondition(flags: Map<string, string | boolean>): ComputerWaitCondition {
  const conditions = (['text', 'enabled', 'window-title'] as const).flatMap((kind) => {
    const value = getOptionalStringFlag(flags, kind)
    return value === undefined ? [] : [{ kind, value }]
  })
  if (conditions.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --text <text>, --enabled <text> or --window-title <text>'
    )
  }
  return conditions[0]
}

function getComputerWaitTimeoutMs(flags: Map<string, string | boolean>): number {
  const timeoutMs =
    getOptionalPositiveIntegerFlag(flags, 'timeout') ?? COMPUTER_WAIT_DEFAULT_TIMEOUT_MS
  if (timeoutMs > COMPUTER_WAIT_MAX_TIMEOUT_MS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--timeout must be at most ${COMPUTER_WAIT_MAX_TIMEOUT_MS} ms`
    )
  }
  return timeoutMs
}
