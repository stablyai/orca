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
  resultAdmission?: 'placed-page' | 'reconciliation'
}

export type BrowserHostCommandResultParams = Omit<
  BrowserClientHostCommandEvent,
  'type' | 'command'
> & {
  result: BrowserClientHostCommandResult
}

export type BrowserHostCommandRecord = {
  event: BrowserClientHostCommandEvent
  resultAdmission: 'placed-page' | 'reconciliation'
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
  terminalCommandIssued: boolean
  activeCapacityReleased: boolean
}

export function assertBrowserHostCommandOrder(
  page: BrowserHostCommandPageState,
  command: BrowserClientHostCommandEvent['command']
): void {
  if (page.nextIssueSequence === 1 && command.type === 'navigate') {
    throw new Error('browser_host_command_create_required')
  }
  if (page.nextIssueSequence > 1) {
    if (page.terminalCommandIssued) {
      throw new Error('browser_host_command_page_terminal')
    }
    if (
      command.type === 'createPage' ||
      command.type === 'reclaimPage' ||
      command.type === 'restorePage'
    ) {
      throw new Error(
        command.type === 'createPage'
          ? 'browser_host_command_create_repeated'
          : 'browser_host_command_bootstrap_repeated'
      )
    }
  }
}

export function recordBrowserHostCommandOrder(
  page: BrowserHostCommandPageState,
  command: BrowserClientHostCommandEvent['command']
): void {
  if (command.type === 'closePage') {
    page.terminalCommandIssued = true
  }
}

export function snapshotBrowserHostPageCommand(
  command: BrowserClientHostCommandEvent['command']
): BrowserClientHostCommandEvent['command'] {
  if (command.type === 'reclaimPage') {
    return Object.freeze({
      ...command,
      previousAuthority: Object.freeze({ ...command.previousAuthority })
    })
  }
  if (command.type === 'closePage') {
    return Object.freeze({
      ...command,
      targetAuthority: Object.freeze({ ...command.targetAuthority })
    })
  }
  return Object.freeze({ ...command })
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
  event: BrowserClientHostCommandEvent,
  resultAdmission: BrowserHostCommandRecord['resultAdmission']
): BrowserHostCommandRecord {
  let resolve = (_result: BrowserClientHostCommandResult): void => {}
  let reject = (_error: Error): void => {}
  const result = new Promise<BrowserClientHostCommandResult>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  void result.catch(() => undefined)
  return { event, resultAdmission, result, resolve, reject }
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

export function assertBrowserHostCommandResultAuthority(
  authority: BrowserClientHostLeaseAuthority,
  params: BrowserHostCommandResultParams
): void {
  if (
    params.pageCommandProtocolVersion !== authority.pageCommandProtocolVersion ||
    params.pageReconciliationProtocolVersion !== authority.pageReconciliationProtocolVersion ||
    params.authorityRuntimeId !== authority.authorityRuntimeId ||
    params.authorityEpoch !== authority.authorityEpoch ||
    params.browserHostClientId !== authority.browserHostClientId ||
    params.browserHostGeneration !== authority.browserHostGeneration
  ) {
    throw new Error('browser_host_command_result_authority_stale')
  }
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
