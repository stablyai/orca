import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'

export const DEFAULT_MAX_OUTSTANDING_COMMANDS = 256
export const DEFAULT_MAX_OUTSTANDING_COMMANDS_PER_PAGE = 32
export const DEFAULT_MAX_CACHED_RESULTS = 1_024
export const DEFAULT_MAX_CACHED_RESULTS_PER_PAGE = 64
export const DEFAULT_MAX_PAGES = 256

export type BrowserHostCommandInput = {
  browserPageId: string
  pageHostGeneration: number
  command: BrowserClientHostCommandEvent['command']
}

export type BrowserHostCommandResultParams = Omit<
  BrowserClientHostCommandEvent,
  'type' | 'command'
> & {
  result: BrowserClientHostCommandResult
}

export type BrowserHostCommandRecord = {
  event: BrowserClientHostCommandEvent
  result: Promise<BrowserClientHostCommandResult>
  resolve: (result: BrowserClientHostCommandResult) => void
  reject: (error: Error) => void
  settled?: BrowserClientHostCommandResult
}

export type BrowserHostCommandPageState = {
  generation: number
  nextIssueSequence: number
  nextSettlementSequence: number
  records: Map<number, BrowserHostCommandRecord>
  outstanding: number
  settledSequences: number[]
}

export function assertBrowserHostCommandOrder(
  page: BrowserHostCommandPageState,
  command: BrowserClientHostCommandEvent['command']
): void {
  if (page.nextIssueSequence === 1 && command.type !== 'createPage') {
    throw new Error('browser_host_command_create_required')
  }
  if (page.nextIssueSequence > 1 && command.type === 'createPage') {
    throw new Error('browser_host_command_create_repeated')
  }
}

export type BrowserHostCommandLedgerOptions = {
  authority: BrowserClientHostLeaseAuthority
  createCommandId?: (commandSequence: number) => string
  maxOutstandingCommands?: number
  maxOutstandingCommandsPerPage?: number
  maxCachedResults?: number
  maxCachedResultsPerPage?: number
  maxPages?: number
}

export function createBrowserHostCommandRecord(
  event: BrowserClientHostCommandEvent
): BrowserHostCommandRecord {
  let resolve = (_result: BrowserClientHostCommandResult): void => {}
  let reject = (_error: Error): void => {}
  const result = new Promise<BrowserClientHostCommandResult>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  void result.catch(() => undefined)
  return { event, result, resolve, reject }
}

export function sameBrowserHostCommandResult(
  first: BrowserClientHostCommandResult,
  second: BrowserClientHostCommandResult
): boolean {
  return (
    first.status === second.status &&
    (first.status === 'completed' ||
      (second.status === 'failed' && first.errorCode === second.errorCode))
  )
}

export function positiveBrowserHostCommandLimit(
  value: number | undefined,
  fallback: number
): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('browser_host_command_limit_invalid')
  }
  return resolved
}
