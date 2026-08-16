import { randomUUID } from 'node:crypto'
import {
  BrowserClientHostPageCommand,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import {
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
  type BrowserHostCommandRecord,
  type BrowserHostCommandResultParams,
  positiveBrowserHostCommandLimit,
  sameBrowserHostCommandResult
} from './browser-host-command-state'
import { replayOutstandingBrowserHostCommands } from './browser-host-command-replay'

export class BrowserHostCommandLedger {
  private readonly authority: BrowserClientHostLeaseAuthority
  private readonly createCommandId: (commandSequence: number) => string
  private readonly maxOutstandingCommands: number
  private readonly maxOutstandingCommandsPerPage: number
  private readonly maxCachedResults: number
  private readonly maxCachedResultsPerPage: number
  private readonly maxPages: number
  private readonly pages = new Map<string, BrowserHostCommandPageState>()
  private readonly settledRecords = new Map<BrowserHostCommandRecord, BrowserHostCommandPageState>()
  private delivery: ((event: BrowserClientHostCommandEvent) => void) | undefined
  private outstandingCommands = 0
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
    this.maxCachedResults = positiveBrowserHostCommandLimit(
      options.maxCachedResults,
      DEFAULT_MAX_CACHED_RESULTS
    )
    this.maxCachedResultsPerPage = positiveBrowserHostCommandLimit(
      options.maxCachedResultsPerPage,
      DEFAULT_MAX_CACHED_RESULTS_PER_PAGE
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
    assertBrowserHostCommandOrder(page, command)
    admission.commit()
    const commandSequence = page.nextIssueSequence
    const event = Object.freeze({
      type: 'command' as const,
      ...this.authority,
      pageCommandProtocolVersion: 1 as const,
      browserPageId: input.browserPageId,
      pageHostGeneration: input.pageHostGeneration,
      commandSequence,
      commandId: this.createCommandId(commandSequence),
      command: Object.freeze(command)
    })
    const record = createBrowserHostCommandRecord(event)
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

  settle(params: BrowserHostCommandResultParams): boolean {
    if (this.closed) {
      throw new Error('browser_host_command_ledger_closed')
    }
    this.assertAuthority(params)
    const page = this.pages.get(params.browserPageId)
    if (!page || page.generation !== params.pageHostGeneration) {
      throw new Error('browser_host_command_result_page_stale')
    }
    if (params.commandSequence < page.nextSettlementSequence) {
      return this.replaySettled(page, params)
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
    this.settledRecords.set(record, page)
    this.evictResults(page)
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
    this.settledRecords.clear()
    this.outstandingCommands = 0
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
    this.releasePageResults(page)
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
    if (!existing && this.pages.size >= this.maxPages) {
      throw new Error('browser_host_command_page_capacity')
    }
    const page: BrowserHostCommandPageState = {
      generation: input.pageHostGeneration,
      nextIssueSequence: 1,
      nextSettlementSequence: 1,
      records: new Map(),
      outstanding: 0,
      settledSequences: []
    }
    return {
      page,
      commit: () => {
        if (existing) {
          this.releasePageResults(existing)
        }
        this.pages.set(input.browserPageId, page)
      }
    }
  }

  private assertAuthority(params: BrowserHostCommandResultParams): void {
    if (
      params.pageCommandProtocolVersion !== this.authority.pageCommandProtocolVersion ||
      params.pageReconciliationProtocolVersion !==
        this.authority.pageReconciliationProtocolVersion ||
      params.authorityRuntimeId !== this.authority.authorityRuntimeId ||
      params.authorityEpoch !== this.authority.authorityEpoch ||
      params.browserHostClientId !== this.authority.browserHostClientId ||
      params.browserHostGeneration !== this.authority.browserHostGeneration
    ) {
      throw new Error('browser_host_command_result_authority_stale')
    }
  }

  private replaySettled(
    page: BrowserHostCommandPageState,
    params: BrowserHostCommandResultParams
  ): false {
    const record = page.records.get(params.commandSequence)
    if (!record) {
      throw new Error('browser_host_command_result_expired')
    }
    if (
      record.event.commandId !== params.commandId ||
      !record.settled ||
      !sameBrowserHostCommandResult(record.settled, params.result)
    ) {
      throw new Error('browser_host_command_result_conflict')
    }
    return false
  }

  private evictResults(page: BrowserHostCommandPageState): void {
    while (page.settledSequences.length > this.maxCachedResultsPerPage) {
      this.evict(page, page.settledSequences[0])
    }
    while (this.settledRecords.size > this.maxCachedResults) {
      const oldest = this.settledRecords.entries().next().value
      if (!oldest) {
        break
      }
      this.evict(oldest[1], oldest[0].event.commandSequence, oldest[0])
    }
  }

  private releasePageResults(page: BrowserHostCommandPageState): void {
    for (const sequence of page.settledSequences.slice()) {
      this.evict(page, sequence)
    }
  }

  private evict(
    page: BrowserHostCommandPageState,
    sequence: number,
    expected?: BrowserHostCommandRecord
  ): void {
    const record = page.records.get(sequence)
    if (!record?.settled || (expected && record !== expected)) {
      return
    }
    page.records.delete(sequence)
    this.settledRecords.delete(record)
    const index = page.settledSequences.indexOf(sequence)
    if (index !== -1) {
      page.settledSequences.splice(index, 1)
    }
  }
}
