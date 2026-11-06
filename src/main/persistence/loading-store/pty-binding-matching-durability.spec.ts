import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'
import * as sessionOwnerFields from '../restoring-sessions/session-owner-fields'
import * as bindingUpdate from './pty-binding-session-update'
import * as ownerInvariants from '../../../shared/workspace-layout/terminal-owner-invariants'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'

const hosts = ['local', 'ssh:matching-host', 'runtime:matching-host'] as const
const binding = {
  worktreeId: `repo-local::/fixture/local::workspace:${TEST_LEAF_1}`,
  tabId: 'matching-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'original-pty',
  incarnationId: 'matching-incarnation'
}

export function registerPtyBindingMatchingDurabilityTests(): void {
  describe('matching bindings that need durability', () => {
    describe.each(hosts)('%s', (hostId) => {
      it.each([false, true])(
        'captures getter edits with settings-only dirty intent (full checkpoint=%s)',
        async (fullCheckpoint) => {
          const { store, authority, readState } = await fixture()
          for (const host of hosts) {
            await store.persistPtyBinding(binding, host)
          }
          const sibling = {
            ...binding,
            worktreeId: `repo-local::/fixture/local::workspace:${TEST_LEAF_2}`,
            tabId: 'sibling-folder-tab',
            ptyId: 'sibling-folder-pty'
          }
          await store.persistPtyBinding(sibling, hostId)
          const session = store.getWorkspaceSession(hostId)
          session.tabsByWorktree[binding.worktreeId][0].ptyId = 'getter-pty'
          session.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId = {
            [binding.leafId]: 'getter-pty'
          }
          store.updateSettings({ theme: 'dark' })
          if (fullCheckpoint) {
            store['runtime'].dirtyProfileStateDomains = null
          }
          authority.captures.length = 0
          const clone = vi.spyOn(sessionOwnerFields, 'cloneWorkspaceSessionState')
          const apply = vi.spyOn(bindingUpdate, 'applyPtyBinding')
          const scan = vi.spyOn(ownerInvariants, 'findTerminalBindingConflict')
          const generation = store['runtime'].writeGeneration
          const gate = authority.pause()
          let acknowledged = false
          const pending = store
            .persistPtyBinding({ ...binding, ptyId: 'getter-pty' }, hostId)
            .then((result) => {
              acknowledged = true
              return result
            })
          await gate.started.promise

          expect(acknowledged).toBe(false)
          expect(authority.captures).toHaveLength(1)
          expect(authority.captures[0].map(({ domain }) => domain)).toEqual(
            expect.arrayContaining([
              'settings',
              hostId === 'local' ? 'workspaceSession' : 'workspaceSessionsByHostId'
            ])
          )
          expect(store['runtime'].writeGeneration).toBe(generation + 1)
          expect(clone).not.toHaveBeenCalled()
          expect(apply).not.toHaveBeenCalled()
          expect(scan).not.toHaveBeenCalled()
          gate.finish.resolve()

          expect(await pending).toBe(true)
          const saved = readState()
          expect(saved.settings.theme).toBe('dark')
          for (const host of hosts) {
            const persisted =
              host === 'local' ? saved.workspaceSession : saved.workspaceSessionsByHostId[host]
            expect(persisted.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId).toEqual({
              [binding.leafId]: host === hostId ? 'getter-pty' : binding.ptyId
            })
          }
          expect(session.tabsByWorktree[sibling.worktreeId][0].ptyId).toBe(sibling.ptyId)
        }
      )
    })

    it.each(['known-failure', 'indeterminate'] as const)(
      'preserves later unscheduled edits and failure publication on %s',
      async (outcome) => {
        const { store, authority, readState } = await fixture()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await store.persistPtyBinding(binding)
        store.updateSettings({ theme: 'dark' })
        const published: { hostId: unknown; ptyId: unknown }[] = []
        store.onWorkspaceSessionWritten((hostId) => {
          published.push({
            hostId,
            ptyId:
              store.getWorkspaceSession().terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId?.[
                binding.leafId
              ]
          })
        })
        const clone = vi.spyOn(sessionOwnerFields, 'cloneWorkspaceSessionState')
        const gate = authority.pause()
        const rejected = expect(store.persistPtyBinding(binding)).rejects.toThrow('disk refused')
        await gate.started.promise
        const session = store.getWorkspaceSession()
        session.tabsByWorktree[binding.worktreeId][0].ptyId = 'successor-pty'
        session.tabsByWorktree[binding.worktreeId][0].customTitle = 'later title'
        session.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId = {
          [binding.leafId]: 'successor-pty'
        }
        gate.finish.reject(new ProfileStateWriterError('test-write', 'disk refused', outcome))
        await rejected

        const initialHostId = ORCA_LAYOUT_OWNER_IS_MAIN ? 'local' : null
        expect(published).toEqual(
          outcome === 'known-failure'
            ? [
                { hostId: initialHostId, ptyId: binding.ptyId },
                { hostId: null, ptyId: 'successor-pty' }
              ]
            : [{ hostId: initialHostId, ptyId: binding.ptyId }]
        )
        expect(store.getWorkspaceSession()).toBe(session)
        expect(session.tabsByWorktree[binding.worktreeId][0]).toMatchObject({
          ptyId: 'successor-pty',
          customTitle: 'later title'
        })
        expect(clone).not.toHaveBeenCalled()
        expect(readState().settings.theme).not.toBe('dark')
        expect(store['runtime'].dirtyProfileStateDomains).toEqual(
          new Set(['settings', 'workspaceSession'])
        )
      }
    )

    it('does not recreate a host removed while its matching write is pending', async () => {
      const { store, authority } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const hostId = hosts[1]
      await store.persistPtyBinding(binding, hostId)
      store.updateSettings({ theme: 'dark' })
      const gate = authority.pause()
      const rejected = expect(store.persistPtyBinding(binding, hostId)).rejects.toThrow(
        'disk refused'
      )
      await gate.started.promise
      store.removeWorkspaceSessionHost(hostId)
      gate.finish.reject(new ProfileStateWriterError('test-write', 'disk refused', 'known-failure'))
      await rejected
      expect(store.getWorkspaceSessionHostIds()).not.toContain(hostId)
    })

    it('keeps later tracked intent after acknowledging the earlier capture', async () => {
      const { store, authority, readState } = await fixture()
      await store.persistPtyBinding(binding)
      store.updateSettings({ theme: 'dark' })
      const gate = authority.pause()
      const pending = store.persistPtyBinding(binding)
      await gate.started.promise
      store.patchWorkspaceSession({ activeTabId: 'later-selection' })
      gate.finish.resolve()
      expect(await pending).toBe(true)
      expect(readState().workspaceSession.activeTabId).not.toBe('later-selection')
      expect(store['runtime'].lastDurableWriteGeneration).toBeLessThan(
        store['runtime'].writeGeneration
      )
      await store.flushPendingOrThrowAsync()
      expect(readState().workspaceSession.activeTabId).toBe('later-selection')
    })

    it('captures once for a burst and resolves deferred inputs once after admission', async () => {
      const { store, authority } = await fixture()
      await store.persistPtyBinding(binding)
      store.updateSettings({ theme: 'dark' })
      authority.captures.length = 0
      const gate = authority.pause()
      const resolve = vi.fn(() => binding)
      const requests = Array.from({ length: 100 }, () => store.persistPtyBinding(resolve))
      expect(resolve).not.toHaveBeenCalled()
      await gate.started.promise
      expect(resolve).toHaveBeenCalledTimes(1)
      gate.finish.resolve()
      expect(await Promise.all(requests)).toEqual(Array.from({ length: 100 }, () => true))
      expect(resolve).toHaveBeenCalledTimes(100)
      expect(authority.captures).toHaveLength(1)
    })

    it('uses the clean path when a queued predecessor already persisted the binding', async () => {
      const { store, authority } = await fixture()
      await store.persistPtyBinding(binding)
      store.updateSettings({ theme: 'dark' })
      authority.captures.length = 0
      const gate = authority.pause()
      const predecessor = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      const resolve = vi.fn(() => binding)
      const pending = store.persistPtyBinding(resolve)
      expect(resolve).not.toHaveBeenCalled()
      gate.finish.resolve()
      await predecessor
      expect(await pending).toBe(true)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(authority.captures).toHaveLength(1)
    })
  })
}
