import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  open,
  nestedProfiles,
  holdCatalogReply,
  readState
} from './profile-state-live-store-test-fixture'
import {
  restoreFixtureForStore,
  tabId,
  leafId,
  workspace,
  paneKey
} from '../loading-store/legacy-pty-restore-test-fixture'
import { installedRestore } from '../loading-store/legacy-pty-runtime-restore-test-fixture'
import { closeLegacyTerminalRestores } from '../../pty/legacy-terminal-restore-ownership'
import * as daemonPaths from '../../daemon/launch/daemon-launch-paths'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const canonical = 'repo-local::/fixture/local@@e2fec859'

describe('installed optional legacy catalog readiness', () => {
  it('uses the original number after timeout without freeing the real read or promoting that operation later', async () => {
    const { root, input } = await nestedProfiles()
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const f = await restoreFixtureForStore(store, root)
      await held.started
      const before = readFileSync(join(root, 'terminal-history/9/checkpoint.json'))
      const { runtime, create } = installedRestore(f)
      const fresh = f.pauseFresh()
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const pending = create()
      await vi.advanceTimersByTimeAsync(1_000)
      await fresh.started
      expect(f.seen).toEqual([
        { id: '9', attachOnly: true },
        { id: '9', attachOnly: false }
      ])
      fresh.gate.resolve()
      vi.useRealTimers()
      // Binding still needs the admitted worker operation; a local timeout cannot free its slot.
      expect(
        readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      ).toBe('9')
      held.gate.resolve()
      const created = await pending
      expect(created.ptyId).toBe('9')
      expect(await store.legacyTerminalIdentityAuthority.captureExternalCatalog().ready).toBe(true)
      expect(existsSync(join(root, 'terminal-history', encodeURIComponent(canonical)))).toBe(false)
      expect(
        (await runtime.serializeMainTerminalBuffer('9', { scrollbackRows: 100 }))?.data
      ).toContain('old terminal screen')
      expect(readFileSync(join(root, 'terminal-history/9/checkpoint.json')).equals(before)).toBe(
        true
      )
      f.alive.delete('9')
      daemonPaths.peekDaemonHistoryRoot()!.invalidate()
      const retry = installedRestore(f)
      const reopened = await retry.create()
      expect(reopened.ptyId).toBe(canonical)
      expect(
        (await retry.runtime.serializeMainTerminalBuffer(canonical, { scrollbackRows: 100 }))?.data
      ).toContain('old terminal screen')
      await retry.runtime.onPtyExit(canonical, 0, `incarnation-${canonical}`, {
        providerExitObserved: true
      })
      await runtime.onPtyExit('9', 0, 'incarnation-9', { providerExitObserved: true })
    } finally {
      vi.useRealTimers()
      held.gate.resolve()
    }
  })

  it('aborts a closed pane during the captured read without dispatching a compatibility process', async () => {
    const { root, input } = await nestedProfiles()
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const f = await restoreFixtureForStore(store, root)
      const { create } = installedRestore(f)
      const pending = create()
      const rejected = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
      await held.started
      closeLegacyTerminalRestores(store.legacyTerminalIdentityAuthority, workspace, {
        kind: 'tab',
        tabId
      })
      await rejected
      expect(f.seen).toEqual([])
      held.gate.resolve()
      expect(await store.legacyTerminalIdentityAuthority.captureExternalCatalog().ready).toBe(true)
      expect(existsSync(join(root, 'terminal-history', encodeURIComponent(canonical)))).toBe(false)
    } finally {
      held.gate.resolve()
    }
  })

  it('declines a superseded epoch without waiting for its replacement or losing original history', async () => {
    const { root, input } = await nestedProfiles()
    const held = holdCatalogReply()
    try {
      const { store } = await open(input)
      const f = await restoreFixtureForStore(store, root)
      const { runtime, create } = installedRestore(f)
      const fresh = f.pauseFresh()
      const pending = create()
      await held.started
      const finish = store.beginLegacyTerminalProfileChange()
      await fresh.started
      expect(f.seen).toEqual([
        { id: '9', attachOnly: true },
        { id: '9', attachOnly: false }
      ])
      finish([])
      fresh.gate.resolve()
      held.gate.resolve()
      expect((await pending).ptyId).toBe('9')
      expect(existsSync(join(root, 'terminal-history', encodeURIComponent(canonical)))).toBe(false)
      expect(
        (await runtime.serializeMainTerminalBuffer('9', { scrollbackRows: 100 }))?.data
      ).toContain('old terminal screen')
      await runtime.onPtyExit('9', 0, 'incarnation-9', { providerExitObserved: true })
    } finally {
      held.gate.resolve()
    }
  })

  it('forwards the admitted original number when no conversion root is available', async () => {
    const { root, input } = await nestedProfiles(0)
    const { store } = await open(input)
    const f = await restoreFixtureForStore(store, root)
    vi.spyOn(daemonPaths, 'peekDaemonHistoryRoot').mockReturnValue(null)
    const { runtime, create } = installedRestore(f)
    const created = await create()
    expect(created.ptyId).toBe('9')
    expect(f.seen).toEqual([
      { id: '9', attachOnly: true },
      { id: '9', attachOnly: false }
    ])
    expect(
      (await runtime.serializeMainTerminalBuffer('9', { scrollbackRows: 100 }))?.data
    ).toContain('old terminal screen')
    expect(
      readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    ).toBe('9')
    await runtime.onPtyExit('9', 0, 'incarnation-9', { providerExitObserved: true })
  })
  it('does not forward a replaced original incarnation when conversion has no root', async () => {
    const { root, input } = await nestedProfiles(0)
    const { store } = await open(input)
    const f = await restoreFixtureForStore(store, root)
    vi.spyOn(daemonPaths, 'peekDaemonHistoryRoot').mockReturnValue(null)
    const probe = f.pauseProbe()
    const { create } = installedRestore(f)
    const pending = create()
    const rejected = expect(pending).rejects.toThrow()
    await probe.started
    const session = structuredClone(store.getWorkspaceSession())
    session.terminalPtyIncarnationsByPaneKey ??= {}
    session.terminalPtyIncarnationsByPaneKey[paneKey] = 'replacement-incarnation'
    store.setWorkspaceSession(session)
    probe.gate.resolve()
    await rejected
    expect(f.seen.filter((call) => !call.attachOnly)).toEqual([])
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey?.[paneKey]).toBe(
      'replacement-incarnation'
    )
  })

  it('reuses an exact committed canonical identity while optional catalog completeness is unknown', async () => {
    const { root, input } = await nestedProfiles(0)
    const { store } = await open(input)
    const f = await restoreFixtureForStore(store, root)
    await expect(f.start(true)).rejects.toThrow('crash before bind')
    expect(f.seen).toEqual([
      { id: '9', attachOnly: true },
      { id: canonical, attachOnly: false }
    ])
    expect(
      JSON.parse(
        readFileSync(
          join(root, 'terminal-history', encodeURIComponent(canonical), 'meta.json'),
          'utf8'
        )
      )
    ).toMatchObject({ cwd: '/fixture/local', cols: 80, rows: 24 })
    store.invalidateLegacyTerminalProfileCatalog()
    const { runtime, create } = installedRestore(f)
    const created = await create()
    expect(created.ptyId).toBe(canonical)
    expect(
      readState(input).workspaceSession.terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
    ).toBe(canonical)
    expect(
      (await runtime.serializeMainTerminalBuffer(canonical, { scrollbackRows: 100 }))?.data
    ).toContain('old terminal screen')
    await runtime.onPtyExit(canonical, 0, `incarnation-${canonical}`, {
      providerExitObserved: true
    })
  })
})
