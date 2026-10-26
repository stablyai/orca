import type * as PageStorage from '../mobile-web-shell/bridge/page-async-storage'
import type * as Visits from './last-visited-worktree-by-host'
import { describe, expect, it, vi } from 'vitest'

const KEY = 'orca:last-visited-worktree'
const HOST = 'host-1'

/** The app's own store, which every page's writes reach and every page load copies. */
const appStore = new Map<string, string>()

type PageModules = {
  storage: typeof PageStorage
  visits: typeof Visits
}

// Load an independent page graph and its load-time store copy.
async function loadPage(pathname: string): Promise<PageModules> {
  vi.resetModules()
  // Use doMock after resetModules; a persistent mock registry would share page adapters.
  vi.doMock('@react-native-async-storage/async-storage', async () => ({
    default: (await import('../mobile-web-shell/bridge/page-async-storage')).default
  }))
  const storage = await import('../mobile-web-shell/bridge/page-async-storage')
  const visits = await import('./last-visited-worktree-by-host')
  storage.publishPageStorage(
    Object.fromEntries(appStore),
    (key, value) => {
      if (value === null) {
        appStore.delete(key)
      } else {
        appStore.set(key, value)
      }
      return true
    },
    HOST,
    pathname
  )
  return { storage, visits }
}

async function mountListPage(): Promise<{
  page: PageModules
  value: () => unknown
  settle: () => Promise<void>
  unmount: () => void
}> {
  const page = await loadPage(`/h/${HOST}`)
  const { createElement } = await import('react')
  const { act, create } = await import('react-test-renderer')
  const { useLastVisitedWorktreeOnHost } = await import('./use-last-visited-worktree-on-host')
  const held: { value: unknown } = { value: undefined }
  function ListProbe(): null {
    held.value = useLastVisitedWorktreeOnHost(HOST)
    return null
  }
  let unmount = () => {}
  await act(async () => {
    const renderer = create(createElement(ListProbe))
    unmount = () => act(() => renderer.unmount())
  })
  // Lets this graph's renderer take state set from outside an act scope.
  const settle = () => act(async () => {})
  return { page, value: () => held.value, settle, unmount }
}

describe('the list page highlight across the shell’s separate pages', () => {
  it('highlights the tapped row after the session page opens and Back returns to the list', async () => {
    appStore.clear()
    const list = await mountListPage()
    expect(list.value()).toBeNull()

    // Another host's visit lands after the list page loaded, so the list's copy is stale.
    appStore.set(
      KEY,
      JSON.stringify({
        hostId: 'host-2',
        worktreeId: 'repo::/w/other',
        byHost: { 'host-2': { worktreeId: 'repo::/w/other' } }
      })
    )

    list.page.visits.noteLastVisitedWorktree({ hostId: HOST, worktreeId: 'repo::/w/2' })
    await list.settle()
    expect(list.value()).toEqual({ worktreeId: 'repo::/w/2' })

    // The session page loads a fresh graph/store copy and persists the visit.
    const session = await loadPage(`/h/${HOST}/session/${encodeURIComponent('repo::/w/2')}`)
    await session.visits.writeLastVisitedWorktree({ hostId: HOST, worktreeId: 'repo::/w/2' })

    expect(list.value()).toEqual({ worktreeId: 'repo::/w/2' })
    const stored = appStore.get(KEY) ?? null
    expect(session.visits.readLastVisitedWorktreeOnHost(stored, 'host-2')).toEqual({
      worktreeId: 'repo::/w/other'
    })
    expect(session.visits.readLastVisitedWorktreeOnHost(stored, HOST)).toEqual({
      worktreeId: 'repo::/w/2'
    })
    list.unmount()
  })

  it('reads the stored visit when the list page loads again', async () => {
    appStore.clear()
    const session = await loadPage(`/h/${HOST}/session/w`)
    await session.visits.writeLastVisitedWorktree({ hostId: HOST, worktreeId: 'repo::/w/3' })
    const list = await mountListPage()
    expect(list.value()).toEqual({ worktreeId: 'repo::/w/3' })
    list.unmount()
  })

  it('follows a session page’s write when the list is the app’s own screen beside it', async () => {
    appStore.clear()
    const list = await mountListPage()
    const mirror = await import('../storage/mirrored-storage-keys')
    mirror.writeMirroredStorage(
      KEY,
      JSON.stringify({
        hostId: HOST,
        worktreeId: 'repo::/w/4',
        byHost: { [HOST]: { worktreeId: 'repo::/w/4' } }
      })
    )
    await list.settle()
    expect(list.value()).toEqual({ worktreeId: 'repo::/w/4' })
    // An older page's write names another host only; this host's visit stands.
    mirror.writeMirroredStorage(KEY, JSON.stringify({ hostId: 'host-2', worktreeId: 'repo::/w/x' }))
    await list.settle()
    expect(list.value()).toEqual({ worktreeId: 'repo::/w/4' })
    list.unmount()
  })
})
