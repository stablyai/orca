import { randomUUID } from 'node:crypto'
import {
  BrowserClientHostPageCommand,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import {
  assertBrowserHostCommandResultAuthority,
  assertBrowserHostCommandOrder,
  createBrowserHostCommandRecord,
  DEFAULT_MAX_CACHED_RESULTS,
  DEFAULT_MAX_CACHED_RESULTS_PER_PAGE,
  DEFAULT_MAX_OUTSTANDING_COMMANDS,
  DEFAULT_MAX_OUTSTANDING_COMMANDS_PER_PAGE,
  DEFAULT_MAX_PAGES,
  type BrowserHostCommandInput,
  type BrowserHostCommandLedgerOptions,
  type BrowserHostCommandPageState,
  type BrowserHostCommandResultParams,
  positiveBrowserHostCommandLimit,
  recordBrowserHostCommandOrder,
  snapshotBrowserHostPageCommand
} from './browser-host-command-state'
import { replayOutstandingBrowserHostCommands } from './browser-host-command-replay'
import {
  hasOutstandingBrowserHostReconciliation,
  isBrowserHostReconciliationResult,
  isBrowserHostUnplacedPageResult,
  replaySettledBrowserHostCommand
} from './browser-host-command-result-replay'
import { BrowserHostCommandResultCache } from './browser-host-command-result-cache'

export class BrowserHostCommandLedger {
  private readonly authority: BrowserClientHostLeaseAuthority
  private readonly createCommandId: (commandSequence: number) => string
  private readonly maxOutstandingCommands: number
  private readonly maxOutstandingCommandsPerPage: number
  private readonly maxPages: number
  private readonly pages = new Map<string, BrowserHostCommandPageState>()
  private readonly resultCache: BrowserHostCommandResultCache
  private delivery: ((event: BrowserClientHostCommandEvent) => void) | undefined
  private outstandingCommands = 0
  private activePages = 0
  private closed = false

  constructor(options: BrowserHostCommandLedgerOptions) {
    if (options.authority.pageCommandProtocolVersion !== 1) {
      throw new Error('browser_host_command_protocol_required')
    }
    this.authority = Object.freeze({ ...options.authority })
    this.createCommandId = options.createCommandId ?? (() => randomUUID())
    this.maxOutstandingCommands = positiveBrowserHostCommandLimit(
      options.maxOutstandingCommands,
      DEFAULT_MAX_OUTSTANDING_COMMANDS
    )
    this.maxOutstandingCommandsPerPage = positiveBrowserHostCommandLimit(
      options.maxOutstandingCommandsPerPage,
      DEFAULT_MAX_OUTSTANDING_COMMANDS_PER_PAGE
    )
    this.resultCache = new BrowserHostCommandResultCache(
      positiveBrowserHostCommandLimit(options.maxCachedResults, DEFAULT_MAX_CACHED_RESULTS),
      positiveBrowserHostCommandLimit(
        options.maxCachedResultsPerPage,
        DEFAULT_MAX_CACHED_RESULTS_PER_PAGE
      ),
      (browserPageId) => this.pages.delete(browserPageId)
    )
    this.maxPages = positiveBrowserHostCommandLimit(options.maxPages, DEFAULT_MAX_PAGES)
  }

  attach(delivery: (event: BrowserClientHostCommandEvent) => void): () => void {
    if (this.closed) {
      throw new Error('browser_host_command_ledger_closed')
    }
    if (this.delivery) {
      throw new Error('browser_host_command_delivery_attached')
    }
    this.delivery = delivery
    try {
      replayOutstandingBrowserHostCommands(this.pages.values(), delivery)
    } catch {
      this.detachDelivery()
      throw new Error('browser_host_command_delivery_failed')
    }
    return () => {
      if (this.delivery === delivery) {
        this.delivery = undefined
      }
    }
  }

  detachDelivery(): void {
    this.delivery = undefined
  }

  issue(input: BrowserHostCommandInput): {
    event: BrowserClientHostCommandEvent
    result: Promise<BrowserClientHostCommandResult>
  } {
    if (this.closed) {
      throw new Error('browser_host_command_ledger_closed')
    }
    if (!this.delivery) {
      throw new Error('browser_host_command_delivery_required')
    }
    if (this.outstandingCommands >= this.maxOutstandingCommands) {
      throw new Error('browser_host_command_capacity')
    }
    const command = BrowserClientHostPageCommand.parse(input.command)
    const admission = this.selectPage(input)
    const { page } = admission
    if (page.outstanding >= this.maxOutstandingCommandsPerPage) {
      throw new Error('browser_host_page_command_capacity')
    }
    assertBrowserHostCommandOrder(page, command, input.resultAdmission ?? 'placed-page')
    admission.commit()
    recordBrowserHostCommandOrder(page, command)
    const commandSequence = page.nextIssueSequence
    const event = Object.freeze({
      type: 'command' as const,
      ...this.authority,
      pageCommandProtocolVersion: 1 as const,
      browserPageId: input.browserPageId,
      pageHostGeneration: input.pageHostGeneration,
      commandSequence,
      commandId: this.createCommandId(commandSequence),
      command: snapshotBrowserHostPageCommand(command)
    })
    const record = createBrowserHostCommandRecord(event, input.resultAdmission ?? 'placed-page')
    page.records.set(commandSequence, record)
    page.nextIssueSequence += 1
    page.outstanding += 1
    this.outstandingCommands += 1
    try {
      this.delivery(event)
    } catch {
      this.close()
      throw new Error('browser_host_command_delivery_failed')
    }
    return { event, result: record.result }
  }

  isReconciliationResult(params: BrowserHostCommandResultParams): boolean {
    return isBrowserHostReconciliationResult(this.pages, params)
  }

  isUnplacedPageResult(params: BrowserHostCommandResultParams): boolean {
    return isBrowserHostUnplacedPageResult(this.pages, params)
  }

  hasOutstandingReconciliation(): boolean {
    return hasOutstandingBrowserHostReconciliation(this.pages)
  }

  settle(params: BrowserHostCommandResultParams): boolean {
    if (this.closed) {
      throw new Error('browser_host_command_ledger_closed')
    }
    assertBrowserHostCommandResultAuthority(this.authority, params)
    const page = this.pages.get(params.browserPageId)
    if (!page || page.generation !== params.pageHostGeneration) {
      throw new Error('browser_host_command_result_page_stale')
    }
    if (params.commandSequence < page.nextSettlementSequence) {
      return replaySettledBrowserHostCommand(page, params)
    }
    if (params.commandSequence > page.nextSettlementSequence) {
      throw new Error('browser_host_command_result_sequence_gap')
    }
    const record = page.records.get(params.commandSequence)
    if (!record || record.event.commandId !== params.commandId || record.settled) {
      throw new Error('browser_host_command_result_conflict')
    }
    const result = Object.freeze({ ...params.result })
    record.settled = result
    record.resolve(result)
    page.nextSettlementSequence += 1
    page.outstanding -= 1
    this.outstandingCommands -= 1
    page.settledSequences.push(params.commandSequence)
    this.resultCache.remember(page, record)
    if (record.event.command.type === 'closePage' && result.status === 'failed') {
      page.terminalCommandIssued = false
    } else if (record.event.command.type === 'closePage' && !page.activeCapacityReleased) {
      page.activeCapacityReleased = true
      this.activePages -= 1
    }
    return true
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.delivery = undefined
    for (const page of this.pages.values()) {
      for (const record of page.records.values()) {
        if (!record.settled) {
          record.reject(new Error('browser_host_command_outcome_unknown'))
        }
      }
    }
    this.pages.clear()
    this.resultCache.clear()
    this.outstandingCommands = 0
    this.activePages = 0
  }

  retirePage(browserPageId: string, pageHostGeneration: number): boolean {
    const page = this.pages.get(browserPageId)
    if (!page) {
      return false
    }
    if (page.generation !== pageHostGeneration) {
      throw new Error('browser_host_command_page_stale')
    }
    for (const record of page.records.values()) {
      if (!record.settled) {
        record.reject(new Error('browser_host_command_outcome_unknown'))
      }
    }
    this.outstandingCommands -= page.outstanding
    page.outstanding = 0
    if (!page.activeCapacityReleased) {
      this.activePages -= 1
    }
    this.resultCache.releasePage(page)
    return this.pages.delete(browserPageId)
  }

  private selectPage(input: BrowserHostCommandInput): {
    page: BrowserHostCommandPageState
    commit: () => void
  } {
    const existing = this.pages.get(input.browserPageId)
    if (existing?.generation === input.pageHostGeneration) {
      return { page: existing, commit: () => {} }
    }
    if (existing && (input.pageHostGeneration < existing.generation || existing.outstanding > 0)) {
      throw new Error('browser_host_command_page_stale')
    }
    if (input.pageHostGeneration < 1) {
      throw new Error('browser_host_command_page_stale')
    }
    const claimsActivePage = !existing || existing.activeCapacityReleased
    if (claimsActivePage && this.activePages >= this.maxPages) {
      throw new Error('browser_host_command_page_capacity')
    }
    const page: BrowserHostCommandPageState = {
      generation: input.pageHostGeneration,
      nextIssueSequence: 1,
      nextSettlementSequence: 1,
      records: new Map(),
      outstanding: 0,
      settledSequences: [],
      terminalCommandIssued: false,
      activeCapacityReleased: false
    }
    return {
      page,
      commit: () => {
        if (existing) {
          this.resultCache.releasePage(existing)
        }
        this.pages.set(input.browserPageId, page)
        if (claimsActivePage) {
          this.activePages += 1
        }
      }
    }
  }
}
