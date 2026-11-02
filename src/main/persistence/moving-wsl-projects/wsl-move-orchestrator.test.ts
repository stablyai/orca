import { describe, expect, it, vi } from 'vitest'
import type { WslMovePreview } from '../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  WslMoveOrchestrator,
  WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS
} from './wsl-move-orchestrator'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'
import {
  WSL_MOVE_ORCHESTRATOR_BACKOFF_MS,
  WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS
} from './wsl-move-orchestrator-transitions'
import { blocker, fakePorts, moved, ready, stateOf } from './wsl-move-orchestrator.test-support'

describe('WslMoveOrchestrator', () => {
  it('moves two distros independently: one finishes, the busy one waits (fake transport)', async () => {
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) =>
        distro === 'Debian' ? ready(distro, [blocker]) : ready(distro)
      )
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await Promise.all([
      orchestrator.trigger('Ubuntu', 'connect'),
      orchestrator.trigger('Debian', 'connect')
    ])
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    expect(stateOf(orchestrator, 'Debian')).toEqual({
      kind: 'deferred',
      blockers: [blocker],
      rechecks: 0
    })
    expect(ports.start).toHaveBeenCalledTimes(1)
    expect(ports.start).toHaveBeenCalledWith('Ubuntu', expect.any(Function))
    expect(ports.saved.get(wslMoveJournalKey('Debian'))?.state.kind).toBe('deferred')
  })

  it('never wakes a distro on its own (A1): not running, no preview', async () => {
    const ports = fakePorts({ prepareHost: vi.fn(async () => 'not-running' as const) })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    await orchestrator.trigger('Ubuntu', 'project-opened')
    expect(ports.preview).not.toHaveBeenCalled()
    // An explicit user action is the user's choice to wake it.
    await orchestrator.trigger('Ubuntu', 'user')
    expect(ports.prepareHost).toHaveBeenCalledTimes(2)
    expect(ports.preview).toHaveBeenCalledTimes(1)
  })

  describe('T3 at startup', () => {
    // Loss of contact is no evidence of state: an unreadable distro is never resumed.
    for (const readiness of ['not-running', 'unverifiable', 'failed'] as const) {
      it(`never resumes a distro that is ${readiness}`, async () => {
        const ports = fakePorts({ prepareHost: vi.fn(async () => readiness) })
        const orchestrator = new WslMoveOrchestrator(ports)
        await orchestrator.trigger('Ubuntu', 'startup')
        expect(ports.preview).not.toHaveBeenCalled()
        expect(ports.start).not.toHaveBeenCalled()
        expect(stateOf(orchestrator, 'Ubuntu')).toBeUndefined()
      })
    }

    it('never resumes when the running-distro read throws', async () => {
      const ports = fakePorts({
        prepareHost: vi.fn(async () => {
          throw new Error('wsl.exe timed out')
        })
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'startup')
      expect(ports.preview).not.toHaveBeenCalled()
    })

    it('keeps a finished move unchanged and unresumed when the registry read fails', async () => {
      const loaded = new Map<string, WslMoveOrchestratorRecord>([
        [
          wslMoveJournalKey('Ubuntu'),
          {
            distro: 'Ubuntu',
            state: { kind: 'done', migrationId: 'm1' },
            attempts: 0,
            appVersion: '1.0.0',
            updatedAt: 0
          }
        ]
      ])
      const ports = fakePorts({
        load: () => loaded,
        finishedMove: () => ({ migrationId: 'm1', distroGuid: 'guid' }),
        checkMovedDistro: vi.fn(async () => {
          throw new Error('reg.exe failed')
        }),
        prepareHost: vi.fn(async () => 'unverifiable' as const)
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'startup')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
      expect(ports.preview).not.toHaveBeenCalled()
      expect(ports.track).not.toHaveBeenCalled()
    })
  })

  describe('T2: a bridge project opened', () => {
    it('moves a distro that is running, readying its host first', async () => {
      const ports = fakePorts()
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'project-opened')
      expect(ports.prepareHost).toHaveBeenCalledWith('Ubuntu', expect.any(Function))
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    it('reads the running distros at most once a minute per distro', async () => {
      const ports = fakePorts({ prepareHost: vi.fn(async () => 'not-running' as const) })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'project-opened')
      await orchestrator.trigger('ubuntu', 'project-opened')
      await orchestrator.trigger('Debian', 'project-opened')
      expect(ports.prepareHost).toHaveBeenCalledTimes(2)
      ports.clock.now += WSL_MOVE_ORCHESTRATOR_PROJECT_OPENED_THROTTLE_MS
      await orchestrator.trigger('Ubuntu', 'project-opened')
      expect(ports.prepareHost).toHaveBeenCalledTimes(3)
    })

    it('readies no host for a distro parked for the user', async () => {
      const ports = fakePorts()
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.userAction('Ubuntu', 'not-now')
      await orchestrator.trigger('Ubuntu', 'project-opened')
      expect(ports.prepareHost).not.toHaveBeenCalled()
    })
  })

  it('makes no automatic start with the kill switch off, but still runs Retry', async () => {
    const ports = fakePorts({ autoMoveEnabled: () => false })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    await orchestrator.trigger('Ubuntu', 'project-opened')
    expect(ports.preview).not.toHaveBeenCalled()
    await orchestrator.userAction('Ubuntu', 'retry')
    await orchestrator.whenIdle()
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('re-checks a deferred move on its timer and starts once the terminals are free', async () => {
    let busy = true
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) => (busy ? ready(distro, [blocker]) : ready(distro)))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')?.kind).toBe('deferred')
    busy = false
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[0])
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('backs off a reset move and retries on its timer while the host stays ready', async () => {
    const start = vi
      .fn<WslMoveOrchestratorPorts['start']>()
      .mockResolvedValueOnce({ outcome: 'reset', migrationId: 'm0', detail: 'ECONNRESET' })
      .mockResolvedValueOnce(moved)
    const ports = fakePorts({ start })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({ kind: 'backoff', reason: 'ECONNRESET' })
    await ports.advance(WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[0] - 1)
    expect(start).toHaveBeenCalledTimes(1)
    await ports.advance(1)
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('treats a port that throws as a transient failure', async () => {
    const ports = fakePorts({
      preview: vi.fn(async () => {
        throw new Error('wsl_move_window_unavailable')
      })
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({
      kind: 'backoff',
      reason: 'wsl_move_window_unavailable'
    })
  })

  it('absorbs a timer that fires while the distro is already being handled', async () => {
    let release: () => void = () => {}
    const ports = fakePorts({
      preview: vi.fn(
        () =>
          new Promise<WslMovePreview>((resolve) => {
            release = () => resolve(ready('Ubuntu'))
          })
      )
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    const first = orchestrator.trigger('Ubuntu', 'connect')
    await vi.waitFor(() => expect(ports.preview).toHaveBeenCalled())
    await orchestrator.trigger('ubuntu', 'timer')
    release()
    await first
    expect(ports.preview).toHaveBeenCalledTimes(1)
  })

  it('reports each state change once, not each unchanged re-check', async () => {
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) => ready(distro, [blocker]))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[0])
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[0])
    expect(vi.mocked(ports.track).mock.calls.map(([, record]) => record.state.kind)).toEqual([
      'deferred'
    ])
  })

  it('marks a finished move whose distro is gone and never previews it (R38)', async () => {
    const ports = fakePorts({
      finishedMove: () => ({ migrationId: 'm1', distroGuid: 'guid' }),
      checkMovedDistro: vi.fn(async () => 'gone' as const)
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'distro-gone' })
    expect(ports.preview).not.toHaveBeenCalled()
  })

  it('offers Restore for a replaced distro, releases the move, then moves on the next trigger', async () => {
    let verdict: 'replaced' | 'present' = 'replaced'
    let finished: { migrationId: string } | null = { migrationId: 'm1' }
    const ports = fakePorts({
      finishedMove: () => finished,
      checkMovedDistro: vi.fn(async () => verdict),
      releaseFinishedMove: vi.fn(async () => {
        finished = null
        verdict = 'present'
        return {
          released: true as const,
          distro: 'Ubuntu',
          repoIds: ['r1'],
          folderWorkspaceIds: []
        }
      })
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'restore-offered' })
    const { release } = await orchestrator.userAction('Ubuntu', 'restore', {
      unsavedWorkspaceIds: ['wt']
    })
    expect(release).toMatchObject({ released: true })
    expect(ports.releaseFinishedMove).toHaveBeenCalledWith('Ubuntu', ['wt'])
    // The window reloads after a release; the move waits for the next trigger.
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
    expect(ports.preview).not.toHaveBeenCalled()
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('keeps Restore offered when the release is refused', async () => {
    const ports = fakePorts({
      finishedMove: () => ({ migrationId: 'm1' }),
      checkMovedDistro: vi.fn(async () => 'replaced' as const),
      releaseFinishedMove: vi.fn(async () => ({
        released: false as const,
        reason: 'unsaved-files' as const,
        unsavedWorkspaceIds: ['wt']
      }))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    const { record, release } = await orchestrator.userAction('Ubuntu', 'restore')
    expect(release).toMatchObject({ released: false, reason: 'unsaved-files' })
    expect(record.state).toEqual({ kind: 'restore-offered' })
  })

  it('snoozes on Not now and leaves the distro alone until it expires', async () => {
    const ports = fakePorts()
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.userAction('Ubuntu', 'not-now')
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(ports.preview).not.toHaveBeenCalled()
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({ kind: 'parked', reason: 'not-now' })
  })

  it('resumes from its sidecar: a move left running is pending, a backoff is rescheduled', async () => {
    const loaded = new Map<string, WslMoveOrchestratorRecord>([
      [
        wslMoveJournalKey('Ubuntu'),
        {
          distro: 'Ubuntu',
          state: { kind: 'moving' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ],
      [
        wslMoveJournalKey('Debian'),
        {
          distro: 'Debian',
          state: { kind: 'backoff', nextAttemptAt: 1_500, reason: 'x' },
          attempts: 1,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    const ports = fakePorts({ load: () => loaded })
    const orchestrator = new WslMoveOrchestrator(ports)
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
    await ports.advance(500)
    expect(stateOf(orchestrator, 'Debian')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('stops its timers on dispose', async () => {
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) => ready(distro, [blocker]))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    orchestrator.dispose()
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS[0])
    expect(ports.preview).toHaveBeenCalledTimes(1)
  })

  describe('review fixes (#33802)', () => {
    // 1: a clean preview, then a start this process already runs, must not strand the record.
    it('goes back to pending when the start is already running elsewhere', async () => {
      const ports = fakePorts({
        start: vi.fn(async () => ({
          outcome: 'refused' as const,
          code: 'wsl_move_already_running' as const
        }))
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(ports.start).toHaveBeenCalledTimes(2)
    })

    // 2: after "Use on this computer again", opening the project must not move it again.
    it('never moves a distro the user brought back until Retry', async () => {
      const ports = fakePorts()
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'released-here'
      })
      ports.clock.now += 30 * 86_400_000
      await orchestrator.trigger('Ubuntu', 'project-opened')
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(ports.start).toHaveBeenCalledTimes(1)
      await orchestrator.userAction('Ubuntu', 'retry')
      await orchestrator.whenIdle()
      expect(ports.start).toHaveBeenCalledTimes(2)
    })

    // 3: a timer step never connects or adds a host, which could hold the distro up.
    it('runs a timer step only on a host that is already ready, without readying one', async () => {
      const start = vi
        .fn<WslMoveOrchestratorPorts['start']>()
        .mockResolvedValueOnce({ outcome: 'reset', migrationId: 'm0', detail: 'ECONNRESET' })
        .mockResolvedValueOnce(moved)
      let hostReady = false
      const ports = fakePorts({ start, isHostReady: vi.fn(() => hostReady) })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(ports.prepareHost).toHaveBeenCalledTimes(1)
      await ports.advance(WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[0])
      expect(ports.prepareHost).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
      hostReady = true
      await orchestrator.trigger('Ubuntu', 'timer')
      expect(ports.prepareHost).toHaveBeenCalledTimes(1)
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    // 4: deferred re-checks stop after 1 m, 5 m and 30 m; an unchanged state is not rewritten.
    it('stops re-checking a deferred move after the series and writes nothing unchanged', async () => {
      const ports = fakePorts({
        preview: vi.fn(async (distro: string) => ready(distro, [blocker]))
      })
      const save = vi.spyOn(ports, 'save')
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      for (const delay of WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS) {
        await ports.advance(delay)
      }
      expect(ports.preview).toHaveBeenCalledTimes(4)
      await ports.advance(24 * 60 * 60_000)
      expect(ports.preview).toHaveBeenCalledTimes(4)
      const writes = save.mock.calls.length
      // A wake previews again, and the same blockers at the same re-check count write nothing.
      await orchestrator.trigger('Ubuntu', 'connect')
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(ports.preview).toHaveBeenCalledTimes(6)
      expect(save.mock.calls.length).toBe(writes + 1)
    })

    // 7: no window to ask is not a failed move.
    it('spends no attempt when the window cannot be asked', async () => {
      const ports = fakePorts({
        preview: vi.fn(async () => {
          throw new Error('wsl_move_window_unavailable')
        })
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(orchestrator.list()[0]?.attempts).toBe(0)
    })

    // 8: each failed attempt of a backoff series is reported, not only the first.
    it('reports every backoff transition, also backoff to backoff', async () => {
      const ports = fakePorts({
        preview: vi.fn(async () => ({
          outcome: 'refused' as const,
          code: 'wsl_move_host_unavailable' as const
        }))
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      await ports.advance(WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[0])
      const backoffs = vi
        .mocked(ports.track)
        .mock.calls.filter(([, record]) => record.state.kind === 'backoff')
        .map(([, record]) => record.attempts)
      expect(backoffs).toEqual([1, 2])
    })

    // 9: a Restore whose release finished before the app quit is not offered again.
    it('reads an offered Restore with no finished move left as pending at start', () => {
      const loaded = new Map<string, WslMoveOrchestratorRecord>([
        [
          wslMoveJournalKey('Ubuntu'),
          {
            distro: 'Ubuntu',
            state: { kind: 'restore-offered' },
            attempts: 0,
            appVersion: '1.0.0',
            updatedAt: 0
          }
        ]
      ])
      const orchestrator = new WslMoveOrchestrator(fakePorts({ load: () => loaded }))
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
    })

    // 10: a project opened while the distro is busy is run after, not dropped.
    it('runs a project opened mid-step once the step ends', async () => {
      let release: () => void = () => {}
      const preview = vi
        .fn<WslMoveOrchestratorPorts['preview']>()
        .mockImplementationOnce(
          () =>
            new Promise<WslMovePreview>((resolve) => {
              release = () => resolve(ready('Ubuntu', [blocker]))
            })
        )
        .mockImplementation(async (distro) => ready(distro))
      const ports = fakePorts({ preview })
      const orchestrator = new WslMoveOrchestrator(ports)
      const first = orchestrator.trigger('Ubuntu', 'connect')
      await vi.waitFor(() => expect(preview).toHaveBeenCalled())
      await orchestrator.trigger('Ubuntu', 'project-opened')
      await orchestrator.trigger('Ubuntu', 'project-opened')
      release()
      await first
      expect(preview).toHaveBeenCalledTimes(2)
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })
  })

  // E11 (#33843): a Remove that could not prove the server stopped leaves the host to the user.

  // Review of #34087: the wait cap counts checks, so a restart after days closed does not park.
  it('does not park on the first in-flight refusal after a restart more than a day later', async () => {
    const loaded = new Map<string, WslMoveOrchestratorRecord>([
      [
        wslMoveJournalKey('Ubuntu'),
        {
          distro: 'Ubuntu',
          state: { kind: 'done', migrationId: 'm1', nextCheckAt: 1_000, waits: 2 },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    const ports = fakePorts({
      load: () => loaded,
      preview: vi.fn(async () => ({
        outcome: 'refused' as const,
        code: 'wsl_move_already_in_flight' as const
      }))
    })
    ports.clock.now += 3 * 24 * 60 * 60_000
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'startup')
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({
      kind: 'done',
      migrationId: 'm1',
      waits: 3
    })
  })
})
