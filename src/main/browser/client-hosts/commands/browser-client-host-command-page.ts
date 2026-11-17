import { sameBrowserClientPageAuthority } from './browser-client-host-command-authority'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  createPageState,
  failedCommandResult,
  resolveCommandRecord,
  createCommandRecord,
  type CommandRecord,
  type PageState
} from './browser-client-host-command-state'

export type PageAdmission = {
  page: PageState
  commit: () => void
}

export function selectCommandPage(
  pages: Map<string, PageState>,
  maxPages: number,
  retiredGenerationFloor: number,
  command: BrowserClientHostCommandEvent
): PageAdmission {
  const page = pages.get(command.browserPageId)
  if (!page) {
    if (pages.size >= maxPages) {
      throw new Error('browser_host_page_capacity')
    }
    if (command.pageHostGeneration < 1 || command.pageHostGeneration <= retiredGenerationFloor) {
      throw new Error('browser_host_page_generation_stale')
    }
    const created = createPageState(command.browserPageId, command.pageHostGeneration)
    return {
      page: created,
      commit: () => pages.set(command.browserPageId, created)
    }
  }
  if (command.pageHostGeneration < page.generation) {
    const previous = page.records.get(command.commandSequence)
    if (
      command.command.type === 'switchProfile' &&
      previous?.result?.status === 'completed' &&
      previous.event.pageHostGeneration === command.pageHostGeneration &&
      previous.event.commandId === command.commandId &&
      commandsMatch(previous.event, command)
    ) {
      return { page, commit: () => {} }
    }
    throw new Error('browser_host_page_generation_stale')
  }
  if (command.pageHostGeneration === page.generation) {
    if (page.retired) {
      throw new Error('browser_host_page_generation_stale')
    }
    if (page.retiring) {
      throw new Error('browser_host_page_retirement_pending')
    }
    return { page, commit: () => {} }
  }
  if (page.retiring) {
    throw new Error('browser_host_page_retirement_pending')
  }
  if (!page.retired) {
    throw new Error('browser_host_page_replacement_requires_retirement')
  }
  const replacement = createPageState(command.browserPageId, command.pageHostGeneration)
  return {
    page: replacement,
    commit: () => pages.set(command.browserPageId, replacement)
  }
}

export function findExistingCommand(
  page: PageState,
  command: BrowserClientHostCommandEvent
): CommandRecord | undefined {
  if (command.commandSequence < page.nextSequence) {
    const existing = page.records.get(command.commandSequence)
    if (!existing) {
      throw new Error('browser_host_command_result_expired')
    }
    if (existing.event.commandId !== command.commandId || !commandsMatch(existing.event, command)) {
      throw new Error('browser_host_command_sequence_conflict')
    }
    return existing
  }
  if (command.commandSequence > page.nextSequence) {
    throw new Error('browser_host_command_sequence_gap')
  }
  if (page.sequencesByCommandId.has(command.commandId)) {
    throw new Error('browser_host_command_id_conflict')
  }
  return undefined
}

function commandsMatch(
  first: BrowserClientHostCommandEvent,
  second: BrowserClientHostCommandEvent
): boolean {
  if (first.command.type !== second.command.type) {
    return false
  }
  if (first.command.type === 'switchProfile' && second.command.type === 'switchProfile') {
    return (
      first.command.nextPageHostGeneration === second.command.nextPageHostGeneration &&
      JSON.stringify(first.command.profile) === JSON.stringify(second.command.profile)
    )
  }
  if (first.command.type === 'navigate' && second.command.type === 'navigate') {
    return first.command.url === second.command.url
  }
  if (first.command.type === 'createPage' && second.command.type === 'createPage') {
    return (
      first.command.browserProfileId === second.command.browserProfileId &&
      first.command.executionHostKey === second.command.executionHostKey &&
      first.command.initialUrl === second.command.initialUrl
    )
  }
  if (first.command.type === 'restorePage' && second.command.type === 'restorePage') {
    return (
      first.command.browserProfileId === second.command.browserProfileId &&
      first.command.executionHostKey === second.command.executionHostKey &&
      first.command.url === second.command.url
    )
  }
  if (first.command.type === 'reclaimPage' && second.command.type === 'reclaimPage') {
    return (
      first.command.browserProfileId === second.command.browserProfileId &&
      first.command.executionHostKey === second.command.executionHostKey &&
      sameBrowserClientPageAuthority(
        first.command.previousAuthority,
        second.command.previousAuthority
      )
    )
  }
  if (first.command.type === 'closePage' && second.command.type === 'closePage') {
    return sameBrowserClientPageAuthority(
      first.command.targetAuthority,
      second.command.targetAuthority
    )
  }
  return false
}

export function assertNewPageCommand(
  page: PageState,
  command: BrowserClientHostCommandEvent
): void {
  const active = [...page.records.values()].filter((record) => record.status !== 'settled')
  if (
    active.some((record) => record.event.command.type === 'switchProfile') ||
    (command.command.type === 'switchProfile' && active.length > 0)
  ) {
    throw new Error('browser_host_profile_switch_pending')
  }
  if (page.nextSequence === 1 && command.command.type === 'navigate') {
    throw new Error('browser_host_command_create_required')
  }
  if (page.nextSequence > 1) {
    if (page.terminalCommandIssued) {
      throw new Error('browser_host_command_page_terminal')
    }
    if (
      command.command.type === 'createPage' ||
      command.command.type === 'reclaimPage' ||
      command.command.type === 'restorePage'
    ) {
      throw new Error(
        command.command.type === 'createPage'
          ? 'browser_host_command_create_repeated'
          : 'browser_host_command_bootstrap_repeated'
      )
    }
  }
  const initializationCleanup =
    command.command.type === 'closePage' && page.initialization !== undefined
  if (page.createFailed && !initializationCleanup) {
    throw new Error('browser_host_command_dependency_failed')
  }
}

export function recordNewPageCommand(
  page: PageState,
  command: BrowserClientHostCommandEvent
): void {
  if (command.command.type === 'closePage') {
    page.terminalCommandIssued = true
  }
}

export function isBrowserClientPageBootstrapCommand(
  command: BrowserClientHostCommandEvent['command']
): boolean {
  return (
    command.type === 'createPage' ||
    command.type === 'reclaimPage' ||
    command.type === 'restorePage'
  )
}

export function recordBrowserClientPageCommandResult(
  page: PageState,
  command: BrowserClientHostCommandEvent['command'],
  result: BrowserClientHostCommandResult
): void {
  if (command.type === 'switchProfile' && result.status === 'completed') {
    page.generation = command.nextPageHostGeneration
  }
  if (isBrowserClientPageBootstrapCommand(command)) {
    page.created = result.status === 'completed'
    page.createFailed = !page.created
  }
  if (command.type === 'closePage' && result.status === 'completed') {
    page.retired = true
  }
  if (command.type === 'closePage' && result.status === 'failed') {
    page.terminalCommandIssued = false
  }
}

export function removeScheduledCommandPage(
  readyPages: PageState[],
  readyPageIds: Set<string>,
  page: PageState
): void {
  readyPageIds.delete(page.browserPageId)
  for (let index = readyPages.length - 1; index >= 0; index -= 1) {
    if (readyPages[index] === page) {
      readyPages.splice(index, 1)
    }
  }
}

export function enqueueBrowserClientPageCommand(
  page: PageState,
  acceptedCommand: BrowserClientHostCommandEvent
): CommandRecord {
  const record = createCommandRecord(acceptedCommand)
  page.records.set(acceptedCommand.commandSequence, record)
  page.sequencesByCommandId.set(acceptedCommand.commandId, acceptedCommand.commandSequence)
  page.queue.push(record)
  page.nextSequence += 1
  if (acceptedCommand.command.type === 'closePage') {
    if (page.initialization?.cancel(acceptedCommand)) {
      record.closeInitialization = page.initialization.close
      record.initializationCleanup = true
      for (const pending of page.queue) {
        if (pending !== record) {
          pending.controller?.abort()
        }
      }
    }
  }
  return record
}

export function releaseBrowserClientPageInitialization(page: PageState): void {
  page.initialization?.release()
  page.initialization = undefined
}

export function settleBrowserClientPageInitialization(
  page: PageState,
  record: CommandRecord,
  result: { status: string }
): void {
  record.closeInitialization = undefined
  if (
    (record.event.command.type === 'navigate' || record.event.command.type === 'closePage') &&
    result.status === 'completed'
  ) {
    releaseBrowserClientPageInitialization(page)
  }
}

export function cancelBrowserClientPageCommands(
  page: PageState,
  errorCode: string,
  preserveInitializationCleanup: boolean,
  removeActive: (record: CommandRecord) => void
): void {
  for (const record of page.queue.slice()) {
    if (preserveInitializationCleanup && record.initializationCleanup) {
      continue
    }
    if (record.status === 'running') {
      record.status = 'cancelling'
      record.controller?.abort()
      resolveCommandRecord(record, failedCommandResult(errorCode))
    } else if (record.status === 'queued') {
      record.status = 'settled'
      record.closeInitialization = undefined
      resolveCommandRecord(record, failedCommandResult(errorCode))
      removeActive(record)
    }
  }
}
