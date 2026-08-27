import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'

export const DEFAULT_MAX_PAGES = 256
export const DEFAULT_MAX_ACTIVE_COMMANDS = 256
export const DEFAULT_MAX_CONCURRENT_HANDLERS = 8
export const DEFAULT_MAX_QUEUED_PER_PAGE = 32
export const DEFAULT_MAX_CACHED_RESULTS_PER_PAGE = 64
export const DEFAULT_MAX_CACHED_COMMAND_RESULTS = 1_024
export const DEFAULT_JOIN_TIMEOUT_MS = 5_000

export type CommandHandler = (
  command: BrowserClientHostCommandEvent,
  signal: AbortSignal
) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>

export type CommandRecord = {
  event: BrowserClientHostCommandEvent
  status: 'queued' | 'running' | 'cancelling' | 'settled'
  promise: Promise<BrowserClientHostCommandResult>
  resolve: (result: BrowserClientHostCommandResult) => void
  result?: BrowserClientHostCommandResult
  controller?: AbortController
  handlerPromise?: Promise<void>
}

export type PageState = {
  browserPageId: string
  generation: number
  nextSequence: number
  created: boolean
  createFailed: boolean
  retiring: boolean
  retired: boolean
  terminalCommandIssued: boolean
  retirementPromise?: Promise<boolean>
  queue: CommandRecord[]
  records: Map<number, CommandRecord>
  sequencesByCommandId: Map<string, number>
  settledSequences: number[]
}

export type DispatcherOptions = {
  authority: BrowserClientHostLeaseAuthority
  handler: CommandHandler
  maxPages?: number
  maxActiveCommands?: number
  maxConcurrentHandlers?: number
  maxQueuedCommandsPerPage?: number
  maxCachedResultsPerPage?: number
  maxCachedCommandResults?: number
  joinTimeoutMs?: number
}

export type DispatcherLimits = {
  maxPages: number
  maxActiveCommands: number
  maxConcurrentHandlers: number
  maxQueuedCommandsPerPage: number
  maxCachedResultsPerPage: number
  maxCachedCommandResults: number
  joinTimeoutMs: number
}

export function resolveDispatcherLimits(options: DispatcherOptions): DispatcherLimits {
  return {
    maxPages: positiveCommandLimit(options.maxPages, DEFAULT_MAX_PAGES),
    maxActiveCommands: positiveCommandLimit(options.maxActiveCommands, DEFAULT_MAX_ACTIVE_COMMANDS),
    maxConcurrentHandlers: positiveCommandLimit(
      options.maxConcurrentHandlers,
      DEFAULT_MAX_CONCURRENT_HANDLERS
    ),
    maxQueuedCommandsPerPage: positiveCommandLimit(
      options.maxQueuedCommandsPerPage,
      DEFAULT_MAX_QUEUED_PER_PAGE
    ),
    maxCachedResultsPerPage: positiveCommandLimit(
      options.maxCachedResultsPerPage,
      DEFAULT_MAX_CACHED_RESULTS_PER_PAGE
    ),
    maxCachedCommandResults: positiveCommandLimit(
      options.maxCachedCommandResults,
      DEFAULT_MAX_CACHED_COMMAND_RESULTS
    ),
    joinTimeoutMs: positiveCommandLimit(options.joinTimeoutMs, DEFAULT_JOIN_TIMEOUT_MS)
  }
}

export function createCommandRecord(event: BrowserClientHostCommandEvent): CommandRecord {
  let resolve = (_result: BrowserClientHostCommandResult): void => {}
  const promise = new Promise<BrowserClientHostCommandResult>((innerResolve) => {
    resolve = innerResolve
  })
  return { event, status: 'queued', promise, resolve }
}

export function snapshotCommandEvent(
  event: BrowserClientHostCommandEvent
): BrowserClientHostCommandEvent {
  const command = snapshotPageCommand(event.command)
  return Object.freeze({ ...event, command })
}

export function createPageState(browserPageId: string, generation: number): PageState {
  return {
    browserPageId,
    generation,
    nextSequence: 1,
    created: false,
    createFailed: false,
    retiring: false,
    retired: false,
    terminalCommandIssued: false,
    queue: [],
    records: new Map(),
    sequencesByCommandId: new Map(),
    settledSequences: []
  }
}

function snapshotPageCommand(
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

export function failedCommandResult(errorCode: string): BrowserClientHostCommandResult {
  return Object.freeze({ status: 'failed', errorCode })
}

export function resolveCommandRecord(
  record: CommandRecord,
  result: BrowserClientHostCommandResult
): void {
  if (!record.result) {
    record.result = result
    record.resolve(result)
  }
}

export function removeActiveCommandRecord(page: PageState, record: CommandRecord): boolean {
  const index = page.queue.indexOf(record)
  if (index === -1) {
    return false
  }
  page.queue.splice(index, 1)
  return true
}

function positiveCommandLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('browser_host_command_limit_invalid')
  }
  return resolved
}
