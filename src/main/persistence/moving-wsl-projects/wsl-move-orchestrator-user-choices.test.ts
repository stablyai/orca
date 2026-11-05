import { describe, expect, it, vi } from 'vitest'
import type { WslMoveUseLocallyResult } from '../../../shared/wsl-move/wsl-moved-project'
import type { WslMovePreview, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import { WslMoveOrchestrator } from './wsl-move-orchestrator'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'
import { blocker, fakePorts, moved, ready, stateOf } from './wsl-move-orchestrator.test-support'

// The orchestrator under the user's own choices and the reviews' race and failure cases.
describe('WslMoveOrchestrator: user choices, races and failures', () => {
  describe('a host whose Remove is pending', () => {
    for (const trigger of ['connect', 'project-opened', 'startup', 'timer', 'user'] as const) {
      it(`never readies, previews or moves it on ${trigger}`, async () => {
        const ports = fakePorts({ hostRemovalPending: vi.fn(() => true) })
        const orchestrator = new WslMoveOrchestrator(ports)
        await orchestrator.trigger('Ubuntu', trigger)
        expect(ports.prepareHost).not.toHaveBeenCalled()
        expect(ports.preview).not.toHaveBeenCalled()
        expect(ports.start).not.toHaveBeenCalled()
        expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
          kind: 'parked',
          reason: 'removal-pending'
        })
      })
    }

    it('stays parked through Retry while the Remove is pending', async () => {
      const ports = fakePorts({ hostRemovalPending: vi.fn(() => true) })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      await orchestrator.userAction('Ubuntu', 'retry')
      await orchestrator.whenIdle()
      expect(ports.start).not.toHaveBeenCalled()
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'parked', reason: 'removal-pending' })
    })

    // Review 3 #2: the park clears once the Remove settles, by whether the host was kept.
    it('resumes once the Remove settles with the host kept (the user pressed Connect)', async () => {
      let pending = true
      const ports = fakePorts({ hostRemovalPending: vi.fn(() => pending) })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      pending = false
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    it('reads a Remove that settled with the host gone as declined', async () => {
      let pending = true
      const ports = fakePorts({
        hostRemovalPending: vi.fn(() => pending),
        hasHost: vi.fn(() => !pending && false)
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      pending = false
      await orchestrator.trigger('Ubuntu', 'project-opened')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'removed'
      })
      expect(ports.prepareHost).not.toHaveBeenCalled()
    })
  })

  describe('re-review fixes (#33802)', () => {
    const offered = (): Map<string, WslMoveOrchestratorRecord> =>
      new Map([
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
    const unreadable = (): never => {
      throw new Error('wsl_move_journal_unreadable')
    }

    // 1: an unreadable journal at startup must not escape the constructor.
    it('starts with an unreadable journal and keeps an offered Restore', () => {
      const orchestrator = new WslMoveOrchestrator(
        fakePorts({ load: offered, finishedMove: unreadable })
      )
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'restore-offered' })
    })

    it('touches nothing while the journal is unreadable', async () => {
      const ports = fakePorts({ finishedMove: unreadable })
      const orchestrator = new WslMoveOrchestrator(ports)
      await expect(orchestrator.trigger('Ubuntu', 'connect')).resolves.toBeUndefined()
      expect(ports.prepareHost).not.toHaveBeenCalled()
      expect(ports.preview).not.toHaveBeenCalled()
    })

    // 2: a release by the user during a step must win over the step's stale view.
    it('does not move a distro the user released while its preview was running', async () => {
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
      const step = orchestrator.trigger('Ubuntu', 'connect')
      await vi.waitFor(() => expect(ports.preview).toHaveBeenCalled())
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      release()
      await step
      expect(ports.start).not.toHaveBeenCalled()
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'released-here'
      })
    })

    it('keeps a release made while the host was being readied', async () => {
      let readied: () => void = () => {}
      const ports = fakePorts({
        prepareHost: vi.fn(
          () =>
            new Promise<'ready'>((resolve) => {
              readied = () => resolve('ready')
            })
        )
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      const step = orchestrator.trigger('Ubuntu', 'connect')
      await vi.waitFor(() => expect(ports.prepareHost).toHaveBeenCalled())
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      readied()
      await step
      expect(ports.preview).not.toHaveBeenCalled()
    })

    // 3: a wake queued during Restore's own busy section runs after it.
    it('replays a wake that arrived during Restore', async () => {
      let finishRelease: () => void = () => {}
      let finished: { migrationId: string } | null = { migrationId: 'm1' }
      const ports = fakePorts({
        load: offered,
        finishedMove: () => finished,
        checkMovedDistro: vi.fn(async () => 'present' as const),
        releaseFinishedMove: vi.fn(
          () =>
            new Promise<WslMoveUseLocallyResult>((resolve) => {
              finishRelease = () => {
                finished = null
                resolve({
                  released: true,
                  distro: 'Ubuntu',
                  repoIds: ['r1'],
                  folderWorkspaceIds: []
                })
              }
            })
        )
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      const restore = orchestrator.userAction('Ubuntu', 'restore')
      await vi.waitFor(() => expect(ports.releaseFinishedMove).toHaveBeenCalled())
      await orchestrator.trigger('Ubuntu', 'project-opened')
      expect(ports.preview).not.toHaveBeenCalled()
      finishRelease()
      await restore
      await orchestrator.whenIdle()
      expect(ports.preview).toHaveBeenCalledTimes(1)
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    it('touches nothing when the host record cannot be read', async () => {
      const ports = fakePorts({ hostRemovalPending: unreadable })
      const orchestrator = new WslMoveOrchestrator(ports)
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(ports.prepareHost).not.toHaveBeenCalled()
      expect(orchestrator.list()).toEqual([])
    })
  })

  // A deliberate Remove of the host is the user declining it: nothing re-adds it on its own.
  describe('a host the user removed', () => {
    it('is never readied again by any automatic trigger, only by the user', async () => {
      const ports = fakePorts()
      const orchestrator = new WslMoveOrchestrator(ports)
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      ports.clock.now += 365 * 86_400_000
      for (const trigger of ['connect', 'project-opened', 'startup', 'timer'] as const) {
        await orchestrator.trigger('Ubuntu', trigger)
      }
      expect(ports.prepareHost).not.toHaveBeenCalled()
      expect(ports.preview).not.toHaveBeenCalled()
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'released-here'
      })
    })

    it('resumes once the user adds the host again', async () => {
      const ports = fakePorts()
      const orchestrator = new WslMoveOrchestrator(ports)
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      orchestrator.hostAddedByUser('Ubuntu')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
      await orchestrator.trigger('Ubuntu', 'connect')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    it('leaves other parks alone when the user adds a host', () => {
      const ports = fakePorts()
      const orchestrator = new WslMoveOrchestrator(ports)
      void orchestrator.userAction('Ubuntu', 'not-now')
      orchestrator.hostAddedByUser('Ubuntu')
      expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({ kind: 'parked', reason: 'not-now' })
    })
  })

  describe('review 3 fixes (#33802)', () => {
    // #3: a release while the start waits on the window's panes must stop the start.
    it('tells the start the distro is no longer wanted once the user released it', async () => {
      const seen: { wanted?: () => boolean } = {}
      let answer: () => void = () => {}
      const ports = fakePorts({
        start: vi.fn(
          (_distro: string, wanted: () => boolean) =>
            new Promise<WslMoveResult>((resolve) => {
              seen.wanted = wanted
              answer = () =>
                resolve(wanted() ? moved : { outcome: 'refused', code: 'wsl_move_cancelled' })
            })
        )
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      const step = orchestrator.trigger('Ubuntu', 'connect')
      await vi.waitFor(() => expect(seen.wanted).toBeDefined())
      expect(seen.wanted?.()).toBe(true)
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      expect(seen.wanted?.()).toBe(false)
      answer()
      await step
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'released-here'
      })
    })

    // #4: the reply to Retry never waits for the move it starts.
    it('answers Retry before the move finishes', async () => {
      let finish: () => void = () => {}
      const ports = fakePorts({
        start: vi.fn(
          () =>
            new Promise<WslMoveResult>((resolve) => {
              finish = () => resolve(moved)
            })
        )
      })
      const orchestrator = new WslMoveOrchestrator(ports)
      const { record } = await orchestrator.userAction('Ubuntu', 'retry')
      expect(record.state).toEqual({ kind: 'pending' })
      await vi.waitFor(() => expect(ports.start).toHaveBeenCalled())
      finish()
      await orchestrator.whenIdle()
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    // #4: a step that throws still runs the wake queued behind it.
    it('replays a queued wake after a step that throws', async () => {
      let answer: () => void = () => {}
      const preview = vi
        .fn<WslMoveOrchestratorPorts['preview']>()
        .mockImplementationOnce(
          () =>
            new Promise<WslMovePreview>((resolve) => {
              answer = () => resolve(ready('Ubuntu', [blocker]))
            })
        )
        .mockImplementation(async (distro) => ready(distro))
      const ports = fakePorts({ preview })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const orchestrator = new WslMoveOrchestrator(ports)
      const step = orchestrator.trigger('Ubuntu', 'connect')
      await vi.waitFor(() => expect(preview).toHaveBeenCalled())
      await orchestrator.trigger('Ubuntu', 'project-opened')
      // Publishing the first step's state fails, so the step throws out of its commit.
      vi.mocked(ports.publish).mockImplementationOnce(() => {
        throw new Error('window gone')
      })
      answer()
      await expect(step).resolves.toBeUndefined()
      await orchestrator.whenIdle()
      expect(preview).toHaveBeenCalledTimes(2)
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })

    // Reviewer nit: a failed sidecar save must neither reject a fire-and-forget trigger nor lose
    // the decision in memory.
    it('keeps going in memory when the sidecar cannot be saved', async () => {
      const ports = fakePorts()
      vi.spyOn(ports, 'save').mockImplementation(() => {
        throw new Error('disk full')
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const orchestrator = new WslMoveOrchestrator(ports)
      await expect(orchestrator.trigger('Ubuntu', 'connect')).resolves.toBeUndefined()
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    })
  })

  // Re-review: the step hands prepareHost a check that turns false once the user declines.
  it('tells prepareHost the distro is no longer wanted after a Remove mid-read', async () => {
    const seen: { wanted?: () => boolean } = {}
    let readied: () => void = () => {}
    const ports = fakePorts({
      prepareHost: vi.fn(
        (_distro: string, wanted: () => boolean) =>
          new Promise<'ready' | 'failed'>((resolve) => {
            seen.wanted = wanted
            readied = () => resolve(wanted() ? 'ready' : 'failed')
          })
      )
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    const step = orchestrator.trigger('Ubuntu', 'project-opened')
    await vi.waitFor(() => expect(seen.wanted).toBeDefined())
    expect(seen.wanted?.()).toBe(true)
    orchestrator.releasedByUser('Ubuntu', 'released-here')
    expect(seen.wanted?.()).toBe(false)
    readied()
    await step
    expect(ports.preview).not.toHaveBeenCalled()
  })

  // D3a-2: the status line needs to know which choice declined the distro.
  describe('decline causes and pruning', () => {
    it('records whether the user released the projects here or removed the host', () => {
      const orchestrator = new WslMoveOrchestrator(fakePorts())
      orchestrator.releasedByUser('Ubuntu', 'removed')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({
        kind: 'parked',
        reason: 'declined',
        cause: 'removed'
      })
      orchestrator.hostAddedByUser('Ubuntu')
      expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
    })

    it('drops records of distros with neither a host nor bridge projects, at start and on Remove', () => {
      let inUse = false
      const loaded = new Map<string, WslMoveOrchestratorRecord>([
        [
          wslMoveJournalKey('Gone'),
          {
            distro: 'Gone',
            state: { kind: 'idle' },
            attempts: 0,
            appVersion: '1.0.0',
            updatedAt: 0
          }
        ]
      ])
      const ports = fakePorts({ load: () => loaded, isDistroInUse: vi.fn(() => inUse) })
      const orchestrator = new WslMoveOrchestrator(ports)
      expect(orchestrator.list()).toEqual([])
      inUse = true
      orchestrator.releasedByUser('Ubuntu', 'released-here')
      expect(orchestrator.list()).toHaveLength(1)
      inUse = false
      // A decline is the user's choice: kept even with nothing left on the distro.
      orchestrator.releasedByUser('Ubuntu', 'removed')
      expect(orchestrator.list()).toHaveLength(1)
    })
  })

  // Pre-review #1: a pruned decline would let a later wake re-add a host the user removed.
  it('never prunes a user choice, even for a distro with nothing left', () => {
    const parked = (reason: 'declined' | 'not-now'): WslMoveOrchestratorRecord => ({
      distro: reason === 'declined' ? 'Removed' : 'Snoozed',
      state:
        reason === 'declined'
          ? { kind: 'parked', reason, cause: 'removed' }
          : { kind: 'parked', reason, until: 2_000 },
      attempts: 0,
      appVersion: '1.0.0',
      updatedAt: 0
    })
    const loaded = new Map<string, WslMoveOrchestratorRecord>([
      [wslMoveJournalKey('Removed'), parked('declined')],
      [wslMoveJournalKey('Snoozed'), parked('not-now')]
    ])
    const orchestrator = new WslMoveOrchestrator(
      fakePorts({ load: () => loaded, isDistroInUse: vi.fn(() => false) })
    )
    expect(
      orchestrator
        .list()
        .map((record) => record.distro)
        .sort()
    ).toEqual(['Removed', 'Snoozed'])
    orchestrator.releasedByUser('Ubuntu', 'removed')
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({ reason: 'declined', cause: 'removed' })
  })

  // #34632's stopped-distro gates: the user's Check again is their act on the distro, so the
  // driver's reads for a just-connected distro are not refused as background work.
  it('runs a Retry step as the user act on its distro, and nothing else', async () => {
    const ports = fakePorts()
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    await orchestrator.trigger('Debian', 'project-opened')
    expect(ports.userActs).toEqual([])
    await orchestrator.userAction('Ubuntu', 'retry')
    await orchestrator.whenIdle()
    expect(ports.userActs).toEqual(['Ubuntu'])
  })
})
