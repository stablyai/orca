// @vitest-environment happy-dom
import {
  directory,
  workspace,
  account,
  clock,
  store,
  host,
  openHost,
  attachContext,
  advanceCatalogClock,
  setCatalogAccount
} from './structured-agent-session-at-rest-command-rig.test-fixture'

import { createMobileCommandMenuHostFixture } from './mobile-queued-edit-host.test-fixture'
import { AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY } from '../../../shared/structured-agent-session-surface-capabilities'

import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import {
  commandDiscoveryRig,
  type CommandDiscoveryChild
} from '../../acp/acp-command-discovery.test-fixture'

import {
  bindAtRestCommandContexts,
  retireAtRestCommandSettings,
  refreshAtRestCommandContext
} from './at-rest-command-context'

import { mkdir } from 'node:fs/promises'

import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  CLAUDE_AT_REST_COMMANDS_TTL_MS,
  ClaudeAtRestCommandCatalog
} from '../../claude/claude-at-rest-commands'

it.each(['claude', 'omp'] as const)(
  'bounds mixed real-host %s admission, retained reads and replacement roots at N/10N',
  async (provider) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const count of [3, 30]) {
        for (const legacy of [0, 1, 2, count]) {
          let hold = true,
            physical = 0,
            peak = 0,
            starts = 0,
            preparations = 0,
            permits = 0,
            peakPermits = 0
          const originalAcquire = PrioritySemaphore.prototype.acquire
          const acquire = vi
            .spyOn(PrioritySemaphore.prototype, 'acquire')
            .mockImplementation(async function (this: PrioritySemaphore, priority, signal) {
              const release = await originalAcquire.call(this, priority, signal)
              peakPermits = Math.max(peakPermits, ++permits)
              let released = false
              return () => {
                expect(released).toBe(false)
                released = true
                permits--
                release()
              }
            })
          let cleanup: Promise<void> | undefined
          let releaseCleanup = () => {}
          let selected = account,
            cwd = workspace
          const roots: CommandDiscoveryChild[] = []
          let rootPeak = 0,
            signals = 0
          const gates: ReturnType<typeof Promise.withResolvers<void>>[] = []
          const launches: { cwd: string; account: string }[] = []
          const enter = async (launch: { cwd: string; account: string }) => {
            starts++
            peak = Math.max(peak, ++physical)
            launches.push(launch)
            const gate = Promise.withResolvers<void>()
            gates.push(gate)
            if (hold) {
              await gate.promise
            }
            physical--
          }
          const omp =
            provider === 'omp'
              ? await commandDiscoveryRig(
                  (child) => {
                    roots.push(child)
                    rootPeak = Math.max(rootPeak, roots.filter((root) => !root.exited).length)
                    const prove = child.proveClose
                    child.proveClose = async () => {
                      await cleanup
                      return prove()
                    }
                    if (child.launch.cwd === undefined) {
                      throw new Error('command discovery must launch in its workspace')
                    }
                    const entering = enter({
                      cwd: child.launch.cwd,
                      account: child.launch.env!.PI_CODING_AGENT_DIR!
                    })
                    const initialize = child.initialize.bind(child)
                    vi.spyOn(child, 'initialize').mockImplementation(async () => {
                      await entering
                      return initialize()
                    })
                  },
                  {
                    resolveWorkspacePath: async () => {
                      preparations++
                      return cwd
                    }
                  }
                )
              : undefined
          const catalog =
            omp?.catalog ??
            new ClaudeAtRestCommandCatalog({
              now: () => clock,
              resolveWorkspacePath: async () => {
                preparations++
                return cwd
              },
              resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: selected }),
              probe: async (input) => {
                input.signal?.addEventListener('abort', () => signals++, { once: true })
                await enter({ cwd: input.cwd, account: input.accountHomePath })
                return [{ name: 'fast', kind: 'command' }]
              }
            })
          const unbind = bindAtRestCommandContexts([catalog])
          const stops: (() => void)[] = [],
            legacyStops: (() => void)[] = []
          let frames = 0,
            hints = 0
          const snapshot = vi.spyOn(catalog, 'snapshot')
          const expectIdle = (sessionIds: readonly string[]) => {
            for (const sessionId of sessionIds) {
              expect(catalog.snapshot(store.getRecord(sessionId)!).commandsPending).toBe(false)
            }
          }
          const emit = (event: AgentSessionSubscribeEvent) => {
            frames++
            if (event.type !== 'end' && event.commandsChanged) {
              hints++
            }
          }
          try {
            await openHost(catalog)
            const ids = await Promise.all(
              Array.from({ length: count + 1 }, (_, index) => attachContext(provider, index))
            )
            for (const [index, sessionId] of ids.entries()) {
              stops.push(
                await host.subscribe({
                  id: `modern-${index}`,
                  sessionId,
                  commandsOnRequest: true,
                  emit
                })
              )
              expectIdle([sessionId])
              if (index < legacy) {
                legacyStops.push(await host.subscribe({ id: `legacy-${index}`, sessionId, emit }))
              }
            }
            stops.push(
              await host.subscribe({
                id: 'duplicate',
                sessionId: ids[0]!,
                commandsOnRequest: true,
                emit
              })
            )
            expectIdle(ids.slice(legacy))
            await vi.waitFor(() => expect(starts).toBe(Math.min(2, legacy)), { interval: 0 })
            const distinct = host.readCommands(ids[count]!, true)
            const overlap = host.readCommands(ids[legacy > 2 ? 2 : 0]!, true)
            const duplicate = host.readCommands(ids[legacy > 2 ? 2 : 0]!, true)
            const admitted = Math.min(2, legacy) + 1 + (legacy === 0 || legacy > 2 ? 1 : 0)
            await vi.waitFor(() => expect(starts).toBe(admitted), { interval: 0 })
            expect(physical).toBe(admitted)
            expect(peak).toBe(admitted)
            expect(permits).toBe(Math.min(2, legacy))
            expect(peakPermits).toBe(Math.min(2, legacy))
            if (omp) {
              expect(omp.children.filter((child) => !child.exited)).toHaveLength(admitted)
              expect(rootPeak).toBe(admitted)
            }
            expect(preparations).toBe(
              new Set([...ids.slice(0, legacy), ids[count], ids[legacy > 2 ? 2 : 0]]).size
            )
            hold = false
            gates.forEach((gate) => gate.resolve())
            await Promise.all([distinct, overlap, duplicate])
            for (const sessionId of ids) {
              await host.readCommands(sessionId, true)
            }
            await vi.waitFor(() => expect(physical).toBe(0), { interval: 0 })
            if (omp) {
              await vi.waitFor(
                () => expect(omp.children.every((child) => child.exited)).toBe(true),
                { interval: 0 }
              )
            }
            await vi.waitFor(() => expect(permits).toBe(0), { interval: 0 })
            const cached = (await host.readCommands(ids[0]!, true)).commands
            let seeded = starts
            expect(seeded).toBe(count + 1)
            expectIdle(ids)
            frames = 0
            hints = 0
            snapshot.mockClear()
            advanceCatalogClock(CLAUDE_AT_REST_COMMANDS_TTL_MS)
            vi.setSystemTime(Date.now() + CLAUDE_AT_REST_COMMANDS_TTL_MS)
            const passive = await host.subscribe({
              id: 'expired-frame',
              sessionId: ids[0]!,
              commandsOnRequest: true,
              emit
            })
            stops.push(passive)
            expect(starts).toBe(seeded)
            expect(snapshot).toHaveBeenCalled()
            expect(frames).toBe(2)
            expectIdle(ids)
            if (legacy > 0) {
              hold = true
              let retained: AgentSessionSubscribeEvent | undefined
              legacyStops.push(
                await host.subscribe({
                  id: 'expired-legacy-frame',
                  sessionId: ids[0]!,
                  emit: (event) => {
                    if ('commands' in event) {
                      retained = event
                    }
                  }
                })
              )
              await vi.waitFor(() => expect(starts).toBe(seeded + 1), { interval: 0 })
              expect(retained).toMatchObject({ commands: cached })
              expect(permits).toBe(1)
            }
            legacyStops.splice(0).forEach((stop) => stop())
            hold = false
            gates.forEach((gate) => gate.resolve())
            await vi.waitFor(() => expect(physical).toBe(0), { interval: 0 })
            await vi.waitFor(() => expect(permits).toBe(0), { interval: 0 })
            if (omp) {
              await vi.waitFor(
                () => expect(omp.children.every((child) => child.exited)).toBe(true),
                { interval: 0 }
              )
            }
            seeded += legacy > 0 ? 1 : 0
            expect(starts).toBe(seeded)
            expectIdle(ids)
            frames = 0
            hints = 0
            selected = join(directory, 'replacement-account')
            retireAtRestCommandSettings(['activeClaudeManagedAccountId'])
            await vi.advanceTimersByTimeAsync(0)
            expect(starts).toBe(seeded)
            expect(hints).toBe(count + 3)
            expect(frames).toBe(count + 3)
            expectIdle(ids)
            snapshot.mockClear()
            frames = 0
            expect(await host.readCommands(ids[0]!, true)).toMatchObject({ commandsPending: false })
            expect(frames).toBe(3)
            expect(snapshot).toHaveBeenCalledTimes(count + 7)
            expect(launches.at(-1)?.account).toBe(provider === 'claude' ? selected : account)
            frames = 0
            hints = 0
            cwd = join(directory, 'replacement-folder')
            await mkdir(cwd, { recursive: true })
            await refreshAtRestCommandContext(async () => {})
            await vi.advanceTimersByTimeAsync(0)
            expect(hints).toBe(count + 3)
            expect(starts).toBe(seeded + 1)
            expectIdle(ids)
            await host.readCommands(ids[0]!, true)
            expect(launches.at(-1)?.cwd).toBe(cwd)
            // Retirement cancels logical ownership while old physical work is still held.
            const beforeOld = starts
            catalog.retireContext()
            await vi.advanceTimersByTimeAsync(0)
            expectIdle(ids)
            expect(starts).toBe(beforeOld)
            hold = true
            const old = host.readCommands(ids[0]!, true)
            const oldSettled = omp
              ? expect(old).rejects.toThrow('Command discovery unavailable')
              : expect(old).resolves.toMatchObject({ commandsPending: true })
            await vi.waitFor(() => expect(physical).toBe(1), { interval: 0 })
            const cleanupGate = Promise.withResolvers<void>()
            cleanup = cleanupGate.promise
            releaseCleanup = () => cleanupGate.resolve()
            // Finish logical demand while retaining physical work across provider/read deadlines.
            await vi.advanceTimersByTimeAsync(10_000)
            await oldSettled
            const beforeReplacement = starts
            catalog.retireContext()
            await vi.advanceTimersByTimeAsync(0)
            expectIdle(ids)
            expect(starts).toBe(beforeReplacement)
            const replacement = host.readCommands(ids[0]!, true)
            await vi.waitFor(() => expect(physical).toBe(2), { interval: 0 })
            expect(peak).toBe(Math.max(admitted, 2))
            if (!omp) {
              expect(signals).toBe(1)
            }
            if (omp) {
              expect(omp.children.filter((child) => !child.exited)).toHaveLength(2)
              expect(rootPeak).toBeGreaterThanOrEqual(2)
            }
            hold = false
            gates.forEach((gate) => gate.resolve())
            cleanupGate.resolve()
            cleanup = undefined
            await replacement
            await vi.waitFor(() => expect(physical).toBe(0), { interval: 0 })
            if (omp) {
              const saved = account
              setCatalogAccount(selected)
              const pinned = await attachContext(provider, count + 2)
              setCatalogAccount(saved)
              await host.readCommands(pinned, true)
              expect(launches.at(-1)?.account).toBe(selected)
              await omp.catalog.closeAll()
              expect(omp.children.every((child) => child.exited)).toBe(true)
            }
          } finally {
            releaseCleanup()
            hold = false
            gates.forEach((gate) => gate.resolve())
            legacyStops.forEach((stop) => stop())
            stops.forEach((stop) => stop())
            unbind()
            await omp?.dispose()
            acquire.mockRestore()
          }
        }
      }
    } finally {
      warned.mockRestore()
      vi.useRealTimers()
    }
  },
  30_000
)
it.each([
  ['claude', false],
  ['omp', false],
  ['claude', true]
] as const)(
  'uses the phone CI host fixture with actual %s dispatch, pending preparation=%s and retirement',
  async (provider, pending) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const fixture = await createMobileCommandMenuHostFixture(provider, pending)
    const frames: AgentSessionSubscribeEvent[] = []
    const stop = await fixture.subscribe((event) => frames.push(event))
    try {
      expect(fixture.starts()).toBe(0)
      if (pending) {
        const read = fixture.read()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(await read).toMatchObject({ commandsPending: true })
        await vi.advanceTimersByTimeAsync(330_000)
        expect(fixture.starts()).toBe(0)
      } else {
        expect((await fixture.read()).commands?.some((row) => row.name === 'fast')).toBe(true)
      }
      await fixture.retire(true)
      expect(frames.some((event) => event.type !== 'end' && event.commandsChanged)).toBe(true)
      expect(fixture.starts()).toBe(pending ? 0 : 1)
      expect((await fixture.read()).commands?.some((row) => row.name === 'fast')).toBe(true)
      expect(fixture.starts()).toBe(pending ? 1 : 2)
    } finally {
      stop()
      await fixture.dispose()
      vi.useRealTimers()
    }
  }
)

it.each(['claude', 'omp'] as const)(
  'keeps marked pre-report phone requests independent, sharing each %s context at N/10N',
  async (provider) => {
    for (const count of [3, 30]) {
      const host = await createMobileCommandMenuHostFixture(provider, true, count)
      try {
        const reads = host.sessionIds.map((id) =>
          host.request(id, [AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY])
        )
        const joined = host.request(host.sessionId, [AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY])
        for (const id of host.sessionIds) {
          expect(host.pending(id)).toBe(true)
        }
        await vi.waitFor(() => expect(host.preparations()).toBe(count))
        expect(host.starts()).toBe(0)
        host.releasePreparation()
        const replies = await Promise.all([...reads, joined])
        expect(replies.every((reply) => reply.commands?.some((row) => row.name === 'fast'))).toBe(
          true
        )
        expect(host.starts()).toBe(count)
        expect(host.preparations()).toBe(count)
        for (const id of host.sessionIds) {
          expect(host.pending(id)).toBe(false)
        }
      } finally {
        await host.dispose()
      }
    }
  }
)
