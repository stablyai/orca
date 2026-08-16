import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import {
  createPageState,
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
  if (first.command.type === 'navigate' && second.command.type === 'navigate') {
    return first.command.url === second.command.url
  }
  if (first.command.type === 'createPage' && second.command.type === 'createPage') {
    return (
      first.command.browserProfileId === second.command.browserProfileId &&
      first.command.executionHostKey === second.command.executionHostKey
    )
  }
  return false
}

export function assertNewPageCommand(
  page: PageState,
  command: BrowserClientHostCommandEvent
): void {
  if (page.nextSequence === 1 && command.command.type !== 'createPage') {
    throw new Error('browser_host_command_create_required')
  }
  if (page.nextSequence > 1 && command.command.type === 'createPage') {
    throw new Error('browser_host_command_create_repeated')
  }
  if (page.createFailed) {
    throw new Error('browser_host_command_dependency_failed')
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
