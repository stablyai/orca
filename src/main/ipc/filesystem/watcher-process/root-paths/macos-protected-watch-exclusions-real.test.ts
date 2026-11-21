import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribe, type AsyncSubscription, type Event } from '@parcel/watcher'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../../watchers/filesystem-watcher-ignore'
import { resolveWatcherRootPaths } from './watcher-event-root-path-rewrite'
import { withMacosProtectedWatchExclusions } from './macos-protected-watch-exclusions'

const DELIVERY_TIMEOUT_MS = 8_000

type Fixture = { home: string; library: string; containerFiles: string[] }

async function makeHome(parent: string, name: string): Promise<Fixture> {
  const home = join(parent, name)
  const data = join(home, 'Library', 'Containers', 'com.example.app', 'Data')
  const group = join(home, 'Library', 'Group Containers', 'group.example')
  await Promise.all([mkdir(data, { recursive: true }), mkdir(group, { recursive: true })])
  const containerFiles = [join(data, 'state.db'), join(group, 'shared.db')]
  // Existing files make later writes modify events, the ones Parcel stats.
  await Promise.all(containerFiles.map((file) => writeFile(file, 'v0')))
  return { home, library: join(home, 'Library'), containerFiles }
}

// Parcel 2.5.6 on macOS: an event reaches JS only after its native isIgnored check, which precedes stat.
describe.skipIf(process.platform !== 'darwin')(
  'macOS protected watch exclusions under Parcel',
  () => {
    let parent: string | null = null
    let subscription: AsyncSubscription | null = null

    afterEach(async () => {
      await subscription?.unsubscribe()
      subscription = null
      if (parent) {
        await rm(parent, { recursive: true, force: true })
        parent = null
      }
    })

    /** Watch `requestedRoot` as the supervisor does and return the Library events that leak. */
    async function libraryEventsFor(
      requestedRoot: string,
      fixture: Fixture,
      homes: string[] | null
    ): Promise<Event[]> {
      const { watchRoot } = resolveWatcherRootPaths(requestedRoot)
      const base = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
      const opts = homes
        ? withMacosProtectedWatchExclusions(watchRoot, base, {
            homes,
            realpath: realpathSync.native
          })
        : base
      const events: Event[] = []
      subscription = await subscribe(watchRoot, (_error, batch) => events.push(...batch), opts)
      const canonicalLibrary = await realpath(fixture.library)
      const sentinel = join(watchRoot, 'notes.md')
      let revision = 0
      await vi.waitFor(
        async () => {
          revision += 1
          await Promise.all(fixture.containerFiles.map((file) => writeFile(file, `v${revision}`)))
          await writeFile(sentinel, `v${revision}`)
          expect(events.some((event) => event.path === sentinel)).toBe(true)
        },
        { timeout: DELIVERY_TIMEOUT_MS, interval: 200 }
      )
      await subscription.unsubscribe()
      subscription = null
      return events.filter((event) => event.path.startsWith(`${canonicalLibrary}/`))
    }

    it('control: without exclusions the container writes reach the watcher', async () => {
      parent = await realpath(await mkdtemp(join(tmpdir(), 'orca-protected-')))
      const fixture = await makeHome(parent, 'home')
      expect((await libraryEventsFor(fixture.home, fixture, null)).length).toBeGreaterThan(0)
    })

    it('excludes a home whose path has glob characters literally', async () => {
      parent = await realpath(await mkdtemp(join(tmpdir(), 'orca-protected-')))
      const fixture = await makeHome(parent, 'home[1]')
      expect(await libraryEventsFor(fixture.home, fixture, [fixture.home])).toEqual([])
    })

    it('excludes through a symlinked root and a symlinked HOME', async () => {
      parent = await realpath(await mkdtemp(join(tmpdir(), 'orca-protected-')))
      const fixture = await makeHome(parent, 'home')
      const alias = join(parent, 'home-link')
      await symlink(fixture.home, alias)
      expect(await libraryEventsFor(alias, fixture, [fixture.home])).toEqual([])
      expect(await libraryEventsFor(fixture.home, fixture, [alias])).toEqual([])
    })

    it('excludes a case-variant HOME spelling', async () => {
      parent = await realpath(await mkdtemp(join(tmpdir(), 'orca-protected-')))
      const fixture = await makeHome(parent, 'home')
      expect(await libraryEventsFor(fixture.home, fixture, [join(parent, 'HOME')])).toEqual([])
    })

    it("excludes a home named like '..profile' under the watched root", async () => {
      parent = await realpath(await mkdtemp(join(tmpdir(), 'orca-protected-')))
      const fixture = await makeHome(parent, '..profile')
      expect(await libraryEventsFor(parent, fixture, [fixture.home])).toEqual([])
    })

    it("excludes the account home's Library when HOME is a separate profile", async () => {
      parent = await realpath(await mkdtemp(join(tmpdir(), 'orca-protected-')))
      const account = await makeHome(parent, 'account')
      const profile = await makeHome(parent, 'profile')
      expect(await libraryEventsFor(account.home, account, [profile.home, account.home])).toEqual(
        []
      )
    })
  }
)
