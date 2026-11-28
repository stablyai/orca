import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveJournalKey } from '../../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import { WslMoveOrchestrator } from '../wsl-move-orchestrator'
import { fakePorts, stateOf, type Fake } from './wsl-move-orchestrator.test-support'
import {
  createWslMoveOrchestratorStore,
  wslMoveOrchestratorStorePath
} from './wsl-move-orchestrator-store'

const declined = (distro: string): WslMoveOrchestratorRecord => ({
  distro,
  state: { kind: 'parked', reason: 'declined', cause: 'released-here' },
  attempts: 0,
  appVersion: '1.0.0',
  updatedAt: 1_000
})

const records = (...distros: string[]) =>
  new Map(distros.map((distro) => [wslMoveJournalKey(distro), declined(distro)]))

const distrosOnDisk = (path: string): Record<string, { state: { kind: string } }> =>
  JSON.parse(readFileSync(path, 'utf8')).distros

describe('WSL move orchestrator sidecar', () => {
  let userDataPath: string
  let path: string
  let ports: Fake
  let orchestrator: WslMoveOrchestrator | undefined
  const start = (installed: string[] = []): WslMoveOrchestrator => {
    const store = createWslMoveOrchestratorStore(userDataPath, () => 42)
    ports = fakePorts({
      load: store.load,
      save: store.save,
      listKnownDistros: async () => installed,
      // A runtime's own distro holds no Orca projects; one distro already finished its move.
      isDistroInUse: vi.fn((distro: string) => distro !== 'runtime-distro'),
      finishedMove: (distro) => (distro === 'Ubuntu-Moved' ? { migrationId: 'm0' } : null)
    })
    orchestrator = new WslMoveOrchestrator(ports)
    return orchestrator
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-orchestrator-'))
    path = wslMoveOrchestratorStorePath(userDataPath)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    orchestrator?.dispose()
    orchestrator = undefined
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('moves nothing on its own while the sidecar is unreadable, then merges it once read', async () => {
    createWslMoveOrchestratorStore(userDataPath).save(records('Ubuntu-A', 'Ubuntu-B'))
    // A directory in the file's place fails the read the way a held file does (not ENOENT).
    renameSync(path, `${path}.held`)
    mkdirSync(path)

    const orchestrator = start()
    await orchestrator.trigger('Ubuntu-A', 'connect')
    await orchestrator.userAction('Ubuntu-C', 'not-now')
    await orchestrator.whenIdle()
    expect(ports.start).not.toHaveBeenCalled()

    rmSync(path, { recursive: true })
    renameSync(`${path}.held`, path)
    await orchestrator.trigger('Ubuntu-A', 'connect')
    await orchestrator.whenIdle()

    expect(ports.start).not.toHaveBeenCalled()
    const onDisk = distrosOnDisk(path)
    expect(Object.keys(onDisk).sort()).toEqual(
      ['Ubuntu-A', 'Ubuntu-B', 'Ubuntu-C'].map(wslMoveJournalKey).sort()
    )
    expect(onDisk[wslMoveJournalKey('Ubuntu-B')]).toEqual(declined('Ubuntu-B'))
    expect(stateOf(orchestrator, 'Ubuntu-C')).toMatchObject({ reason: 'not-now' })
  })

  it('holds the distros installed when an unparseable sidecar is set aside, across a restart', async () => {
    const whole = JSON.stringify({ version: 1, distros: Object.fromEntries(records('Ubuntu-B')) })
    const truncated = whole.slice(0, -2)
    writeFileSync(path, truncated)

    const orchestrator = start(['Ubuntu-B', 'runtime-distro', 'Ubuntu-Moved'])
    await orchestrator.whenIdle()
    await orchestrator.trigger('Ubuntu-B', 'connect')
    await orchestrator.trigger('Ubuntu-New', 'connect')
    await orchestrator.whenIdle()

    expect(readFileSync(`${path}.corrupt-42`, 'utf8')).toBe(truncated)
    expect(vi.mocked(ports.start).mock.calls.map(([distro]) => distro)).toEqual(['Ubuntu-New'])
    expect(stateOf(orchestrator, 'Ubuntu-B')).toEqual({
      kind: 'parked',
      reason: 'declined',
      cause: 'released-here',
      stateLost: true
    })
    expect(stateOf(orchestrator, 'runtime-distro')).toBeUndefined()
    expect(stateOf(orchestrator, 'Ubuntu-Moved')).toEqual({ kind: 'done', migrationId: 'm0' })

    orchestrator.dispose()
    const restarted = start(['Ubuntu-B', 'Ubuntu-New'])
    await restarted.trigger('Ubuntu-B', 'connect')
    await restarted.whenIdle()
    expect(ports.start).not.toHaveBeenCalled()
  })

  it('takes back a decline read after the outage when the user added the host during it', () => {
    createWslMoveOrchestratorStore(userDataPath).save(records('Ubuntu-A'))
    renameSync(path, `${path}.held`)
    mkdirSync(path)

    const orchestrator = start()
    orchestrator.hostAddedByUser('Ubuntu-A')
    rmSync(path, { recursive: true })
    renameSync(`${path}.held`, path)
    orchestrator.hostAddedByUser('Ubuntu-B')

    expect(stateOf(orchestrator, 'Ubuntu-A')).toEqual({ kind: 'pending' })
    expect(distrosOnDisk(path)[wslMoveJournalKey('Ubuntu-A')].state).toEqual({ kind: 'pending' })
  })

  it("leaves a newer build's sidecar in place and moves nothing on its own", async () => {
    const newer = JSON.stringify({ version: 2, distros: {} })
    writeFileSync(path, newer)

    const orchestrator = start()
    await orchestrator.trigger('Ubuntu-A', 'connect')
    await orchestrator.userAction('Ubuntu-B', 'not-now')
    await orchestrator.whenIdle()

    expect(ports.start).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe(newer)
    expect(readdirSync(userDataPath)).toEqual(['wsl-move-orchestrator.json'])
  })

  it('keeps a record a newer build wrote under version 1, and leaves its distro to the user', async () => {
    const future = {
      ...declined('Ubuntu-B'),
      state: { kind: 'parked', reason: 'declined', cause: 'later-cause' }
    }
    writeFileSync(
      path,
      JSON.stringify({ version: 1, distros: { [wslMoveJournalKey('Ubuntu-B')]: future } })
    )

    const orchestrator = start()
    await orchestrator.trigger('Ubuntu-B', 'connect')
    await orchestrator.userAction('Ubuntu-A', 'not-now')
    await orchestrator.whenIdle()

    expect(ports.start).not.toHaveBeenCalled()
    expect(distrosOnDisk(path)[wslMoveJournalKey('Ubuntu-B')]).toEqual(future)
  })

  it('retries a save a sharing violation refused', async () => {
    const saved: string[][] = []
    let busy = true
    ports = fakePorts({
      save: (current) => {
        if (busy) {
          busy = false
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        }
        saved.push([...current.values()].map((record) => record.distro))
      }
    })
    orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.userAction('Ubuntu-A', 'not-now')
    expect(saved).toEqual([])

    await ports.advance(50)
    expect(saved).toEqual([['Ubuntu-A']])
  })
})
