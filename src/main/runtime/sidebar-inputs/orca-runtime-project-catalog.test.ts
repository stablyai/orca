// Runs on plain Node, as orcad does: the catalog comes from main's own store, no window publishes it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { readSidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../shared/mobile-project-sections-contract'
import { OrcaRuntimeService } from '../orca-runtime'
import { ALL_RPC_METHODS } from '../rpc/methods'
import type { RuntimeStore } from '../runtime-store-contract'
import { requireSwitchedOn } from './require-switched-on'
import { TestPhone } from './sidebar-inputs-feed.test-fixture'
import { partialRuntimeStore } from '../runtime-store-partial-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

function group(id: string): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function setup() {
  let repos: Repo[] = [
    { id: 'r', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1, projectGroupId: 'a' }
  ]
  const store: Pick<RuntimeStore, 'getRepos' | 'getProjectGroups'> = {
    getRepos: () => repos,
    getProjectGroups: () => [group('a'), group('school')]
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  const events: RuntimeClientEvent[] = []
  runtime.onClientEvent((event) => events.push(event))
  const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
  /** Moves the repo the way a host's IPC write does: store first, then reposChanged. */
  const write = (groupId: string): void => {
    repos = repos.map((entry) => ({ ...entry, projectGroupId: groupId }))
    runtime.notifyReposChangedForRemoteClients()
  }
  return {
    runtime,
    feed,
    write,
    move: async (groupId: string) => {
      write(groupId)
      await vi.advanceTimersByTimeAsync(60)
      const notice = events.findLast((event) => event.type === 'sidebarInputsChanged')
      if (notice?.type !== 'sidebarInputsChanged') {
        throw new Error('no change notice')
      }
      return notice
    }
  }
}

function groupOf(phone: TestPhone): string | null | undefined {
  const installed = phone.state.installed
  return installed
    ? readSidebarFeedDomains(installed).projectCatalog?.repos.find((repo) => repo.id === 'r')
        ?.projectGroupId
    : undefined
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the project catalog in the sidebar feed', () => {
  it('installs a group move with the revision that announced it', async () => {
    const { feed, move } = setup()
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(groupOf(phone)).toBe('a')

    phone.notice(await move('school'))
    await phone.settle()
    expect(groupOf(phone)).toBe('school')
    phone.disconnect()
  })

  it('reaches a move made while an earlier read is held, with no further trigger', async () => {
    const { feed, move } = setup()
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    phone.refresh()
    // The host answered the read before the move; its reply reaches the phone only after.
    const held = await phone.serveOne()
    const notice = await move('school')
    phone.notice(notice)
    held.deliver()
    expect(groupOf(phone)).toBe('a')
    await phone.settle()
    expect(groupOf(phone)).toBe('school')
    phone.disconnect()
  })

  it('answers mobileRelay.projectSections from the same catalog for a page that predates it', async () => {
    const { runtime, write } = setup()
    write('school')
    const method = ALL_RPC_METHODS.find((entry) => entry.name === MOBILE_PROJECT_SECTIONS_METHOD)
    const reply = await method?.handler(undefined, { runtime })
    expect(reply).toMatchObject({
      catalog: {
        repos: [{ id: 'r', projectGroupId: 'school', executionHostId: 'local' }],
        projectGroups: [{ id: 'a' }, { id: 'school' }]
      }
    })
  })
})
