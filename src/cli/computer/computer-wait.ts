import type {
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult,
  ComputerWindowListWindow
} from '../../shared/computer-use-runtime-types'
import { parseComputerTreeText } from '../../shared/computer-use-tree-text'
import {
  computerTreeElementsMatching,
  isComputerTreeElementDisabled,
  queryComputerTreeText
} from './computer-tree-query'
import { cliErrorCode } from '../output/cli-error'
import { formatGetAppState, formatListWindows } from './computer-format'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'

export type ComputerWaitCondition =
  | { kind: 'text'; value: string }
  | { kind: 'enabled'; value: string }
  | { kind: 'window-title'; value: string }

type ComputerTreeWaitCondition = Exclude<ComputerWaitCondition, { kind: 'window-title' }>

export type ComputerWaitSummary = ComputerWaitCondition & { elapsedMs: number }

export type ComputerWaitSnapshotResult = ComputerSnapshotResult & { wait: ComputerWaitSummary }

export type ComputerWaitWindowsResult = ComputerListWindowsResult & { wait: ComputerWaitSummary }

const POLL_INTERVAL_MS = 250
// Why: the app or window may not exist yet; waiting for it to appear is part of the wait.
const NOT_YET_CODES = new Set(['app_not_found', 'window_not_found', 'window_stale'])

type Poll<T> = { call: () => Promise<RuntimeRpcSuccess<T>>; check: (result: T) => string | null }

// Polls the same reads every provider and runtime version serves, so the wait needs no host support.
export async function waitForComputerSnapshot(
  client: RuntimeClient,
  condition: ComputerTreeWaitCondition,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<RuntimeRpcSuccess<ComputerWaitSnapshotResult>> {
  if (condition.kind === 'enabled') {
    await assertDisabledStateSupported(client)
  }
  const { response, elapsedMs } = await pollUntil(condition, timeoutMs, {
    call: () =>
      client.call<ComputerSnapshotResult>('computer.getAppState', {
        ...params,
        noScreenshot: true
      }),
    check: (result) => snapshotMiss(condition, result.snapshot.treeText)
  })
  const { snapshot } = response.result
  return {
    ...response,
    result: {
      ...response.result,
      snapshot: {
        ...snapshot,
        treeText: queryComputerTreeText(snapshot.treeText, { query: condition.value })
      },
      wait: { ...condition, elapsedMs }
    }
  }
}

export async function waitForComputerWindowTitle(
  client: RuntimeClient,
  condition: Extract<ComputerWaitCondition, { kind: 'window-title' }>,
  app: string,
  timeoutMs: number
): Promise<RuntimeRpcSuccess<ComputerWaitWindowsResult>> {
  const { response, elapsedMs } = await pollUntil(condition, timeoutMs, {
    call: () => client.call<ComputerListWindowsResult>('computer.listWindows', { app }),
    check: (result) =>
      matchingWindows(result.windows, condition.value).length > 0
        ? null
        : `its windows are ${result.windows.map((window) => `"${window.title}"`).join(', ') || 'none'}`
  })
  return {
    ...response,
    result: {
      ...response.result,
      windows: matchingWindows(response.result.windows, condition.value),
      wait: { ...condition, elapsedMs }
    }
  }
}

function snapshotMiss(condition: ComputerTreeWaitCondition, treeText: string): string | null {
  const matches = computerTreeElementsMatching(
    parseComputerTreeText(treeText).elements,
    condition.value
  )
  if (matches.length === 0) {
    return `no element contains "${condition.value}"`
  }
  if (condition.kind === 'text') {
    return null
  }
  const disabled = matches.filter(isComputerTreeElementDisabled)
  if (disabled.length === 0) {
    return null
  }
  return `${disabled.length} of ${matches.length} matching elements are disabled: ${disabled
    .slice(0, 3)
    .map((element) => element.lines[0].trim())
    .join(' | ')}`
}

function matchingWindows(
  windows: ComputerWindowListWindow[],
  title: string
): ComputerWindowListWindow[] {
  const needle = title.toLowerCase()
  return windows.filter((window) => window.title.toLowerCase().includes(needle))
}

async function assertDisabledStateSupported(client: RuntimeClient): Promise<void> {
  const { result } = await client.call<ComputerProviderCapabilities>('computer.capabilities', {})
  if (result.supports.observation.disabledState !== true) {
    // Why: without the trait every element reads as enabled, so the wait would pass at once.
    throw new RuntimeClientError(
      'unsupported_capability',
      `The ${result.provider} computer-use provider on this host does not report disabled elements, so --enabled cannot be checked. Update Orca on that host, or wait with --text instead.`
    )
  }
}

async function pollUntil<T>(
  condition: ComputerWaitCondition,
  timeoutMs: number,
  poll: Poll<T>
): Promise<{ response: RuntimeRpcSuccess<T>; elapsedMs: number }> {
  const startedAt = Date.now()
  for (;;) {
    let miss: string
    try {
      const response = await poll.call()
      const result = poll.check(response.result)
      if (result === null) {
        return { response, elapsedMs: Date.now() - startedAt }
      }
      miss = result
    } catch (error) {
      const code = cliErrorCode(error)
      if (!code || !NOT_YET_CODES.has(code)) {
        throw error
      }
      miss = `${code}: ${error instanceof Error ? error.message : String(error)}`
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw waitTimeoutError(condition, timeoutMs, miss)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs)))
  }
}

function waitTimeoutError(
  condition: ComputerWaitCondition,
  timeoutMs: number,
  lastSeen: string
): RuntimeClientError {
  const goal =
    condition.kind === 'text'
      ? `an element containing "${condition.value}"`
      : condition.kind === 'enabled'
        ? `elements containing "${condition.value}" to be enabled`
        : `a window titled "${condition.value}"`
  return new RuntimeClientError(
    'wait_timeout',
    `Timed out after ${timeoutMs} ms waiting for ${goal}; last check: ${lastSeen}.`,
    {
      nextSteps: [
        'Run `orca computer get-app-state --app <app> --json` to see what the app shows now.',
        'If the app is still working, wait again with a longer --timeout; otherwise match text the tree actually shows.',
        ...(condition.kind === 'enabled'
          ? ['Every matching element must be enabled, so use text only the intended control shows.']
          : [])
      ]
    }
  )
}

export function formatComputerWaitSnapshot(result: ComputerWaitSnapshotResult): string {
  return `${waitHeadline(result.wait)}\n${formatGetAppState(result)}`
}

export function formatComputerWaitWindows(result: ComputerWaitWindowsResult): string {
  return `${waitHeadline(result.wait)}\n${formatListWindows(result)}`
}

function waitHeadline(wait: ComputerWaitSummary): string {
  return `Condition --${wait.kind} "${wait.value}" held after ${wait.elapsedMs} ms.`
}
