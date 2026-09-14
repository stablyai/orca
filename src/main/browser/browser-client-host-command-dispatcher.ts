import {
  BrowserClientHostCommandResult as CommandResultSchema,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import {
  assertBrowserClientHostCommandAuthority,
  snapshotBrowserClientHostLeaseAuthority
} from './browser-client-host-command-authority'
import { joinBrowserClientHostCommands } from './browser-client-host-command-join'
import {
  assertNewPageCommand,
  findExistingCommand,
  isBrowserClientPageBootstrapCommand,
  recordBrowserClientPageCommandResult,
  recordNewPageCommand,
  removeScheduledCommandPage,
  selectCommandPage
} from './browser-client-host-command-page'
import { BrowserClientHostCommandResultCache } from './browser-client-host-command-result-cache'
import {
  createCommandRecord,
  type CommandHandler,
  type DispatcherOptions,
  failedCommandResult,
  type CommandRecord,
  type PageState,
  removeActiveCommandRecord,
  resolveDispatcherLimits,
  resolveCommandRecord,
  snapshotCommandEvent
} from './browser-client-host-command-state'

export class BrowserClientHostCommandDispatcher {
  private readonly authority: BrowserClientHostLeaseAuthority
  private readonly handler: CommandHandler
  private readonly maxPages: number
  private readonly maxActiveCommands: number
  private readonly maxConcurrentHandlers: number
  private readonly maxQueuedCommandsPerPage: number
  private readonly joinTimeoutMs: number
  private readonly resultCache: BrowserClientHostCommandResultCache
  private readonly pages = new Map<string, PageState>()
  private readonly readyPages: PageState[] = []
  private readonly readyPageIds = new Set<string>()
  private activeCommands = 0
  private runningHandlers = 0
  private retiredGenerationFloor = 0
  private readonly closedSettlement: Promise<void>
  private resolveClosedSettlement = (): void => {}
  private closedSettlementResolved = false
  private closed = false

  constructor(options: DispatcherOptions) {
    if (options.authority.pageCommandProtocolVersion !== 1) {
      throw new Error('browser_host_command_protocol_required')
    }
    this.authority = snapshotBrowserClientHostLeaseAuthority(options.authority)
    this.handler = options.handler
    const limits = resolveDispatcherLimits(options)
    this.maxPages = limits.maxPages
    this.maxActiveCommands = limits.maxActiveCommands
    this.maxConcurrentHandlers = limits.maxConcurrentHandlers
    this.maxQueuedCommandsPerPage = limits.maxQueuedCommandsPerPage
    this.resultCache = new BrowserClientHostCommandResultCache(
      limits.maxCachedResultsPerPage,
      limits.maxCachedCommandResults
    )
    this.joinTimeoutMs = limits.joinTimeoutMs
    this.closedSettlement = new Promise((resolve) => {
      this.resolveClosedSettlement = resolve
    })
  }

  dispatch(command: BrowserClientHostCommandEvent): Promise<BrowserClientHostCommandResult> {
    if (this.closed) {
      throw new Error('browser_host_command_dispatcher_closed')
    }
    assertBrowserClientHostCommandAuthority(this.authority, command)
    const acceptedCommand = snapshotCommandEvent(command)
    const admission = selectCommandPage(
      this.pages,
      this.maxPages,
      this.retiredGenerationFloor,
      acceptedCommand
    )
    const { page } = admission
    const existing = findExistingCommand(page, acceptedCommand)
    if (existing) {
      return existing.promise
    }
    assertNewPageCommand(page, acceptedCommand)
    if (this.activeCommands >= this.maxActiveCommands) {
      throw new Error('browser_host_command_capacity')
    }
    if (page.queue.length >= this.maxQueuedCommandsPerPage) {
      throw new Error('browser_host_page_command_capacity')
    }
    const previousPage = this.pages.get(acceptedCommand.browserPageId)
    admission.commit()
    recordNewPageCommand(page, acceptedCommand)
    if (previousPage && previousPage !== page) {
      this.resultCache.releasePage(previousPage)
    }
    const record = createCommandRecord(acceptedCommand)
    page.records.set(acceptedCommand.commandSequence, record)
    page.sequencesByCommandId.set(acceptedCommand.commandId, acceptedCommand.commandSequence)
    page.queue.push(record)
    page.nextSequence += 1
    this.activeCommands += 1
    this.schedulePage(page)
    return record.promise
  }

  async retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    const page = this.pages.get(browserPageId)
    if (!page || page.generation !== pageHostGeneration) {
      throw new Error('browser_host_page_generation_stale')
    }
    if (page.retired) {
      return true
    }
    if (page.retirementPromise) {
      return page.retirementPromise
    }
    let resolveRetirement = (_settled: boolean): void => {}
    const retirement = new Promise<boolean>((resolve) => {
      resolveRetirement = resolve
    })
    page.retirementPromise = retirement
    page.retiring = true
    removeScheduledCommandPage(this.readyPages, this.readyPageIds, page)
    this.cancelPage(page, 'browser_host_command_cancelled')
    void this.waitForPageHandlers(page).then((settled) => {
      if (settled) {
        this.finishRetirement(page)
      } else if (page.retirementPromise === retirement) {
        page.retirementPromise = undefined
      }
      resolveRetirement(settled)
    })
    return retirement
  }

  forgetPage(browserPageId: string, pageHostGeneration: number): boolean {
    const page = this.pages.get(browserPageId)
    if (!page || page.generation !== pageHostGeneration || !page.retired) {
      return false
    }
    this.retiredGenerationFloor = Math.max(this.retiredGenerationFloor, pageHostGeneration)
    this.resultCache.releasePage(page)
    return this.pages.delete(browserPageId)
  }

  async close(): Promise<boolean> {
    if (this.closed) {
      return this.runningHandlers === 0
    }
    this.closed = true
    this.readyPages.length = 0
    this.readyPageIds.clear()
    for (const page of this.pages.values()) {
      page.retiring = true
      this.cancelPage(page, 'browser_host_command_cancelled')
    }
    const settled = await joinBrowserClientHostCommands(
      [...this.pages.values()].flatMap((page) =>
        page.queue.flatMap((record) => (record.handlerPromise ? [record.handlerPromise] : []))
      ),
      this.joinTimeoutMs
    )
    if (settled) {
      this.pages.clear()
      this.resultCache.clear()
    }
    this.settleClosedHandlers()
    return settled
  }

  whenClosed(): Promise<void> {
    return this.closedSettlement
  }

  private schedulePage(page: PageState): void {
    if (
      this.closed ||
      page.retiring ||
      page.retired ||
      page.queue[0]?.status !== 'queued' ||
      this.readyPageIds.has(page.browserPageId)
    ) {
      return
    }
    this.readyPageIds.add(page.browserPageId)
    this.readyPages.push(page)
    this.drain()
  }

  private drain(): void {
    while (!this.closed && this.runningHandlers < this.maxConcurrentHandlers) {
      const page = this.readyPages.shift()
      if (!page) {
        return
      }
      this.readyPageIds.delete(page.browserPageId)
      const record = page.queue[0]
      if (!page.retiring && record?.status === 'queued') {
        this.startHandler(page, record)
      }
    }
  }

  private startHandler(page: PageState, record: CommandRecord): void {
    record.status = 'running'
    record.controller = new AbortController()
    this.runningHandlers += 1
    let finishJoin = (): void => {}
    record.handlerPromise = new Promise<void>((resolve) => {
      finishJoin = resolve
    })
    let handled: BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>
    try {
      handled = this.handler(record.event, record.controller.signal)
    } catch {
      handled = Promise.reject(new Error('handler failed'))
    }
    void Promise.resolve(handled)
      .then((result) => {
        const parsed = CommandResultSchema.safeParse(result)
        this.finishHandler(
          page,
          record,
          parsed.success
            ? Object.freeze(parsed.data)
            : failedCommandResult('browser_host_command_result_invalid')
        )
      })
      .catch(() =>
        this.finishHandler(page, record, failedCommandResult('browser_host_command_failed'))
      )
      .finally(finishJoin)
  }

  private finishHandler(
    page: PageState,
    record: CommandRecord,
    result: BrowserClientHostCommandResult
  ): void {
    this.runningHandlers -= 1
    if (record.status === 'running') {
      resolveCommandRecord(record, result)
      recordBrowserClientPageCommandResult(page, record.event.command, result)
    }
    record.status = 'settled'
    record.controller = undefined
    record.handlerPromise = undefined
    this.removeActiveRecord(page, record)
    if (isBrowserClientPageBootstrapCommand(record.event.command) && !page.created) {
      this.cancelPage(page, 'browser_host_command_dependency_failed')
    }
    if (page.retiring && page.queue.length === 0) {
      this.finishRetirement(page)
    } else {
      this.schedulePage(page)
    }
    this.drain()
    if (this.closed && this.runningHandlers === 0) {
      this.pages.clear()
      this.resultCache.clear()
      this.settleClosedHandlers()
    }
  }

  private settleClosedHandlers(): void {
    if (!this.closed || this.runningHandlers !== 0 || this.closedSettlementResolved) {
      return
    }
    this.closedSettlementResolved = true
    this.resolveClosedSettlement()
  }

  private cancelPage(page: PageState, errorCode: string): void {
    for (const record of page.queue.slice()) {
      if (record.status === 'running') {
        record.status = 'cancelling'
        record.controller?.abort()
        resolveCommandRecord(record, failedCommandResult(errorCode))
      } else if (record.status === 'queued') {
        record.status = 'settled'
        resolveCommandRecord(record, failedCommandResult(errorCode))
        this.removeActiveRecord(page, record)
      }
    }
  }

  private removeActiveRecord(page: PageState, record: CommandRecord): void {
    if (removeActiveCommandRecord(page, record)) {
      this.activeCommands -= 1
      this.resultCache.record(page, record)
    }
  }

  private async waitForPageHandlers(page: PageState): Promise<boolean> {
    return joinBrowserClientHostCommands(
      page.queue.flatMap((record) => (record.handlerPromise ? [record.handlerPromise] : [])),
      this.joinTimeoutMs
    )
  }

  private finishRetirement(page: PageState): void {
    page.retiring = false
    page.retired = true
  }
}
