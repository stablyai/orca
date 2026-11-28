// A teammate's terminals, pages and files in a shared agent's Home are their own list's: each runs or
// reads on the host, and nothing of the owner's (lists, versions, picks, the window's page) moves.
// Through the real dispatcher, runtime, browser registry and record store; the host's PTY daemon and
// the computer hosting a page are the only stand-ins.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { physicalReload } from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { getRuntimeBrowserPageRegistry } from '../../runtime/browser/client-pages/runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../../runtime/browser-host/leases/browser-host-lease-registry-instance'
import { C, O, rig, settleTeammateRig, type Tabs } from './teammate-tabs.test-support'
import {
  browserUnavailableError,
  setRuntimeBrowserCommandsFactory
} from '../../runtime/browser/installation/runtime-browser-commands-factory'
import { orcadClientPageCommand } from '../../orcad/browser-providers/orcad-client-page-commands'
import { retainRuntimeBrowserClientPageRecord } from '../../runtime/browser/client-pages/runtime-browser-client-page-release'
import { getBrowserHostRequestRegistry } from '../../runtime/browser-host/leases/browser-host-request-registry'
import { BROWSER_HOST_WEBVIEW_CAPABILITY } from '../../runtime/browser-host/leases/browser-host-capability-selection'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../shared/browser/client-hosting/browser-client-automation-protocol'

afterEach(async () => {
  setRuntimeBrowserCommandsFactory(null)
  await settleTeammateRig()
})

type Rig = Awaited<ReturnType<typeof rig>>

/** The host's terminals start as the desktop's do: each spawn a live process under the id it was
 *  asked for, else one the daemon names in the workspace, recorded as it starts (before it
 *  registers); a kill its exit. */
function startTerminalsOnTheHost(r: Rig) {
  r.runtime['graphStatus'] = 'ready'
  r.runtime.setPtyController({
    spawn: async ({ sessionId, worktreeId }) => {
      const id = sessionId ?? `${worktreeId}@@${randomUUID()}`
      r.runtime.vouchSpawnedTerminal(id)
      return { id }
    },
    write: () => true,
    kill: (ptyId) => {
      void r.runtime.onPtyExit(ptyId, 0)
      return true
    },
    getForegroundProcess: async () => null
  })
}

/** Pages as a headless host serves them (orcad's client-page commands, no engine of its own). Set
 *  before the runtime starts, which reads it once. */
function servePagesHeadless() {
  const refuse = (): never => {
    throw browserUnavailableError()
  }
  setRuntimeBrowserCommandsFactory(
    (host) =>
      new Proxy(Object.create(null), {
        get: (_target, property) =>
          typeof property !== 'string' || property === 'then'
            ? undefined
            : (orcadClientPageCommand(host, property, refuse, () => false) ?? refuse)
      }),
    { headless: true, clientHostingWithoutEngine: true }
  )
}

/** The computer that hosts a page answers its create at once, as a paired desktop does. */
function hostPagesOnTheCallersComputer(r: Rig) {
  const leases = getBrowserHostLeaseRegistry(r.runtime)
  vi.spyOn(leases, 'createClientPage').mockImplementation(async (input) => {
    const placement = {
      kind: 'client' as const,
      browserHostClientId: input.browserHostClientId,
      browserHostGeneration: 1,
      pageHostGeneration: 1
    }
    input.committed?.(placement)
    return placement
  })
}

const Terminal = z.object({
  // Ready to attach: the client streams it by this handle.
  tab: z.looseObject({ id: z.string(), ptyId: z.string(), terminal: z.string() })
})
const openTerminal = async (r: Rig, deviceId: string) =>
  Terminal.parse(
    await r.call(deviceId, 'session.tabs.createTerminal', { worktree: `id:${r.workspace}` })
  ).tab
const openPage = async (r: Rig, deviceId: string) =>
  z.object({ browserPageId: z.string() }).parse(
    await r.call(deviceId, 'browser.tabCreate', {
      worktree: `id:${r.workspace}`,
      url: 'about:blank',
      placement: { kind: 'client', browserHostClientId: `${deviceId}-host` }
    })
  ).browserPageId
const openFile = async (r: Rig, deviceId: string, relativePath: string) =>
  z.object({ activeTabId: z.string().nullable() }).parse(
    await r.call(deviceId, 'session.tabs.openFile', {
      worktree: `id:${r.workspace}`,
      relativePath
    })
  ).activeTabId
const tabIds = (tabs: Tabs) => tabs.tabs.map((tab) => tab.id)
const pagesHeldBy = (r: Rig, deviceId: string) =>
  getRuntimeBrowserPageRegistry(r.runtime)
    .everyPage(r.workspace)
    .filter((page) => page.pairedDeviceId === deviceId)

/** All the owner has in the Home, byte for byte: their devices' lists, the host's list with its
 *  version and exit proofs, the owner's devices' picks, and the page pageless commands go to. */
async function ownersSide(r: Rig): Promise<string> {
  const picks = r.runtime['clientSessionTabSelections'].serialize()
  return JSON.stringify({
    view: await r.ownerView(),
    hostList: r.runtime['mobileSessionTabsByWorktree'].get(r.workspace) ?? null,
    picks: Object.entries(picks).filter(([device]) => device.startsWith('owner-')),
    page: getRuntimeBrowserPageRegistry(r.runtime)
      .everyPage(r.workspace)
      .find((page) => page.active)?.browserPageId
  })
}

it('opens a teammate’s terminal, page and file in their own list alone, each shown where they opened it', async () => {
  servePagesHeadless()
  const r = await rig()
  startTerminalsOnTheHost(r)
  hostPagesOnTheCallersComputer(r)
  await r.reveal('owner-desk', O)
  // The owner's own terminal there, as before.
  const ownersTerminal = await openTerminal(r, 'owner-desk')
  expect(tabIds(await r.list('owner-phone'))).toContain(ownersTerminal.id)
  // Mate already picked a tab on their desk: what they open next still shows there.
  await r.reveal('mate-desk', C)
  await r.activate('mate-desk', C)
  await chatTabCommandsSettled()
  const before = await ownersSide(r)

  const terminal = await openTerminal(r, 'mate-desk')
  const shown = await r.list('mate-desk')
  expect(shown.activeTabId).toBe(terminal.id)
  // Its group lists and picks the terminal by its parent tab, as every list's groups do.
  const { parentTabId } = z
    .object({ parentTabId: z.string() })
    .parse(shown.tabs.find((tab) => tab.id === terminal.id))
  expect(shown.tabGroups).toMatchObject([{ activeTabId: parentTabId }])
  // Unprojected too: a device with no pick of its own reads the list's own group.
  expect((await r.list('mate-phone')).tabGroups).toMatchObject([{ activeTabId: parentTabId }])
  const page = await openPage(r, 'mate-desk')
  expect((await r.list('mate-desk')).activeTabId).toBe(page)
  const file = await openFile(r, 'mate-desk', 'notes/plan.md')
  await chatTabCommandsSettled()

  const mates = await r.list('mate-phone')
  expect(tabIds(mates)).toEqual([`agent-session:${C}`, terminal.id, page, file])
  expect(mates.tabGroups).toMatchObject([
    { tabOrder: [`agent-session:${C}`, parentTabId, page, file], activeTabId: file }
  ])
  expect(mates.tabs.at(-1)).toMatchObject({ type: 'file', relativePath: 'notes/plan.md' })
  expect((await r.list('mate-desk')).activeTabId).toBe(file)
  expect(await ownersSide(r)).toBe(before)
  expect(tabIds(await r.list('other-desk'))).toEqual([])
  // The host's census says whose the terminal is, so no window of the owner's adopts it.
  const census = z
    .object({ terminals: z.array(z.looseObject({ ptyId: z.string().nullable() })) })
    .parse(await r.call('owner-desk', 'terminal.list', { worktree: `id:${r.workspace}` }))
  expect(census.terminals.find((row) => row.ptyId === terminal.ptyId)).toMatchObject({
    heldByTeammate: true
  })

  // Closing ends each in their list alone; the host's list never hears of the exit.
  await r.call('mate-desk', 'session.tabs.close', {
    worktree: `id:${r.workspace}`,
    tabId: terminal.id,
    reason: 'user'
  })
  await chatTabCommandsSettled()
  expect(tabIds(await r.list('mate-phone'))).toEqual([`agent-session:${C}`, page, file])
  expect(r.runtime['ptysById'].get(terminal.ptyId)?.connected).not.toBe(true)
  expect(await ownersSide(r)).toBe(before)
  for (const tabId of [file, page]) {
    await r.call('mate-desk', 'session.tabs.close', {
      worktree: `id:${r.workspace}`,
      tabId,
      reason: 'user'
    })
  }
  expect(tabIds(await r.list('mate-desk'))).toEqual([`agent-session:${C}`])
  expect(await ownersSide(r)).toBe(before)
})

it('keeps the host’s page and page list when a teammate opens or picks one', async () => {
  servePagesHeadless()
  const r = await rig()
  hostPagesOnTheCallersComputer(r)
  const worktree = `id:${r.workspace}`
  const pages = getRuntimeBrowserPageRegistry(r.runtime)
  const routed = () => pages.everyPage(r.workspace).find((page) => page.active)?.browserPageId
  const hostTabs = async () =>
    z
      .object({ tabs: z.array(z.object({ browserPageId: z.string() })) })
      .parse(await r.call('owner-desk', 'browser.tabList', { worktree }))
      .tabs.map((tab) => tab.browserPageId)
  const ownersPage = await openPage(r, 'owner-desk')
  expect(routed()).toBe(ownersPage)
  const ownersFrames = await r.subscribe('owner-phone')
  const framesBefore = ownersFrames.length

  // Opened at an address, so the page navigates after it is made, as a link does.
  const matesPage = z.object({ browserPageId: z.string() }).parse(
    await r.call('mate-desk', 'browser.tabCreate', {
      worktree,
      url: 'https://example.com/',
      placement: { kind: 'client', browserHostClientId: 'mate-desk-host' }
    })
  ).browserPageId
  expect(pages.getPage(matesPage)?.holder).toMatch(/^teammate:/)
  expect(routed()).toBe(ownersPage)
  // The owner's and the agent's page list and indexes are the host's alone.
  expect(await hostTabs()).toEqual([ownersPage])
  // Picking theirs on their own strip, or by the page command, moves no host selection.
  await r.call('mate-desk', 'session.tabs.activate', {
    worktree,
    tabId: matesPage,
    navigation: 'caller'
  })
  await r.call('mate-desk', 'browser.tabSwitch', { worktree, page: matesPage })
  await chatTabCommandsSettled()
  expect(routed()).toBe(ownersPage)
  expect(tabIds(await r.list('owner-desk'))).toEqual([ownersPage])
  // Nothing of theirs reached the owner's stream.
  expect(ownersFrames.length).toBe(framesBefore)
})

it('keeps a teammate’s page in their own list across a host restart, and quiet to the owner', async () => {
  servePagesHeadless()
  const r = await rig()
  hostPagesOnTheCallersComputer(r)
  const ownersPage = await openPage(r, 'owner-desk')
  const ownersFrames = await r.subscribe('owner-phone')
  const framesBefore = ownersFrames.length
  const matesPage = await openPage(r, 'mate-desk')
  const page = getRuntimeBrowserPageRegistry(r.runtime).getPage(matesPage)!
  // Their computer goes away: the page is kept for its return, and only their list hears.
  retainRuntimeBrowserClientPageRecord(r.runtime, matesPage, page.placement)
  await chatTabCommandsSettled()
  expect(ownersFrames.length).toBe(framesBefore)

  const fresh = await rig({ opened: await physicalReload(r) })
  // As startup does.
  fresh.runtime.rehydrateClientHostedBrowserPages()
  expect(getRuntimeBrowserPageRegistry(fresh.runtime).getPage(matesPage)?.holder).toMatch(
    /^teammate:/
  )
  expect(tabIds(await fresh.list('mate-phone'))).toEqual([matesPage])
  expect(tabIds(await fresh.list('owner-desk'))).toEqual([ownersPage])
})

it('never picks a teammate’s computer for a page no one placed, nor asks it to host one', async () => {
  servePagesHeadless()
  const r = await rig()
  hostPagesOnTheCallersComputer(r)
  const worktree = `id:${r.workspace}`
  r.stream('mate-desk', 'browser.clientHost.attach', {
    authorityRuntimeId: r.runtime.getRuntimeId(),
    browserHostClientId: 'mate-desk-host',
    hostCapabilities: [BROWSER_HOST_WEBVIEW_CAPABILITY, BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY]
  })
  r.stream('mate-desk', 'runtime.clientEvents.subscribe', { browserHostRequests: true })
  await vi.waitFor(() =>
    expect(getBrowserHostLeaseRegistry(r.runtime).select('mate-desk-host').pairedDeviceId).toBe(
      'mate-desk'
    )
  )
  expect(getBrowserHostRequestRegistry(r.runtime).hasVolunteer()).toBe(false)
  // The owner's open has no computer to go to; Mate's own create still lands on theirs.
  expect(
    await r.send('owner-desk', 'browser.openUrl', { worktree, url: 'https://example.com/' })
  ).toMatchObject({ ok: false })
  expect(pagesHeldBy(r, 'mate-desk')).toEqual([])
  await openPage(r, 'mate-desk')
  expect(pagesHeldBy(r, 'mate-desk')).toHaveLength(1)
  // An owner's computer volunteers as before.
  r.stream('owner-desk', 'runtime.clientEvents.subscribe', { browserHostRequests: true })
  await vi.waitFor(() => expect(getBrowserHostRequestRegistry(r.runtime).hasVolunteer()).toBe(true))
})

it('stops, closes or sleeps only the host’s terminals of a Home, and never for a teammate', async () => {
  const r = await rig()
  startTerminalsOnTheHost(r)
  const worktree = `id:${r.workspace}`
  const ownersTerminal = await openTerminal(r, 'owner-desk')
  const matesTerminal = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  const live = (ptyId: string) => r.runtime['ptysById'].get(ptyId)?.connected === true

  for (const method of ['terminal.stop', 'terminal.closeAll', 'terminal.sleep', 'worktree.sleep']) {
    expect(await r.send('mate-desk', method, { worktree }), method).toMatchObject({ ok: false })
  }
  expect(live(ownersTerminal.ptyId) && live(matesTerminal.ptyId)).toBe(true)
  await r.call('owner-desk', 'terminal.stop', { worktree })
  expect(live(ownersTerminal.ptyId)).toBe(false)
  expect(live(matesTerminal.ptyId)).toBe(true)
  expect(tabIds(await r.list('mate-desk'))).toEqual([matesTerminal.id])
})

it('ends a teammate’s terminal that exits on its own in their list alone', async () => {
  const r = await rig()
  startTerminalsOnTheHost(r)
  await r.reveal('owner-desk', O)
  const terminal = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()
  const before = await ownersSide(r)

  await r.runtime.onPtyExit(terminal.ptyId, 0)
  await chatTabCommandsSettled()
  expect(tabIds(await r.list('mate-desk'))).toEqual([])
  // Gone from their saved list too, so a restart brings back no dead tab.
  expect(JSON.stringify(r.runtime['personSessionTabs'].serialize())).not.toContain(terminal.ptyId)
  expect(await ownersSide(r)).toBe(before)
})

it('brings a teammate’s terminal back in their own list alone after a host restart', async () => {
  const r = await rig()
  startTerminalsOnTheHost(r)
  const terminal = await openTerminal(r, 'mate-desk')
  await chatTabCommandsSettled()

  const fresh = await rig({ opened: await physicalReload(r) })
  // The daemon kept the process: the restarted host reattaches it, with no pane named.
  fresh.runtime.registerPty(terminal.ptyId, fresh.workspace)
  await chatTabCommandsSettled()

  expect(fresh.runtime['ptysById'].get(terminal.ptyId)?.holder).toMatch(/^teammate:/)
  expect(tabIds(await fresh.list('mate-phone'))).toEqual([terminal.id])
  expect(tabIds(await fresh.list('owner-desk'))).toEqual([])
  await fresh.runtime.onPtyExit(terminal.ptyId, 0)
  expect(tabIds(await fresh.list('mate-phone'))).toEqual([])
})
