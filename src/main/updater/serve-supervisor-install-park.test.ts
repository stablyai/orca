import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ackFileName,
  acksDir,
  bundleCoordinationDir,
  decideServeParkHold,
  parkRecordPath,
  parseServeParkRecord,
  supervisorsDir,
  type ServeParkRecord
} from '../../shared/serve-bundle-coordination'

import {
  commitServeSupervisorPark,
  parkServeSupervisorsForInstall,
  releaseServeSupervisorPark
} from './serve-supervisor-install-park'

const CHILD = 424242

describe('parkServeSupervisorsForInstall', () => {
  let root: string
  let executable: string
  let dir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-install-park-'))
    const bundle = join(root, 'Orca.app')
    executable = join(bundle, 'Contents', 'MacOS', 'Orca')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(bundle, 'Contents', 'Info.plist'), 'v1')
    dir = bundleCoordinationDir(realpathSync(bundle), join(root, 'data'))
  })

  afterEach(async () => {
    await releaseServeSupervisorPark()
    await rm(root, { recursive: true, force: true })
  })

  async function register(childPid: number, heartbeatAt = Date.now()): Promise<void> {
    await mkdir(supervisorsDir(dir), { recursive: true })
    await writeFile(
      join(supervisorsDir(dir), `${process.pid}.json`),
      JSON.stringify({
        protocol: 1,
        pid: process.pid,
        childPid,
        heartbeatAt,
        label: 'com.stablyai.orca.serve.default'
      })
    )
  }

  async function readRecord(): Promise<ServeParkRecord | null> {
    return parseServeParkRecord(JSON.parse(await readFile(parkRecordPath(dir), 'utf8')))
  }

  const deps = (overrides: Partial<Parameters<typeof parkServeSupervisorsForInstall>[2]> = {}) => ({
    macUserDataRoot: join(root, 'data'),
    listBlockers: async () => [],
    sleep: async () => undefined,
    ...overrides
  })

  it('refuses as today when any blocker is not a registered supervisor child', async () => {
    await register(CHILD)
    await expect(parkServeSupervisorsForInstall(executable, [CHILD, 7], deps())).resolves.toEqual({
      kind: 'refused',
      reason: 'unregistered',
      pids: [7]
    })
    // A stale registration counts as unregistered.
    await register(CHILD, Date.now() - 60_000)
    await expect(parkServeSupervisorsForInstall(executable, [CHILD], deps())).resolves.toEqual({
      kind: 'refused',
      reason: 'unregistered',
      pids: [CHILD]
    })
    await expect(readdir(dir)).resolves.not.toContain('park.json')
  })

  it('parks, commits, then lets supervisors wait for the bundle to change', async () => {
    await register(CHILD)
    const result = await parkServeSupervisorsForInstall(
      executable,
      [CHILD],
      deps({
        sleep: async () => {
          const record = await readRecord()
          await mkdir(acksDir(dir), { recursive: true })
          await writeFile(join(acksDir(dir), ackFileName(record!.attemptId, process.pid)), '{}')
        }
      })
    )
    expect(result).toEqual({ kind: 'parked' })
    expect((await readRecord())?.phase).toBe('park')
    await commitServeSupervisorPark(async () => [])
    const committed = await readRecord()
    expect(committed?.phase).toBe('commit')

    const facts = { now: Date.now(), installerAlive: false, bundleNow: committed!.bundleBefore }
    expect(decideServeParkHold(committed, facts)).toBe('hold')
    expect(decideServeParkHold(committed, { ...facts, bundleNow: 'new' })).toBe('release')
    // Mid-swap the bundle is briefly absent; that is not a finished install.
    expect(decideServeParkHold(committed, { ...facts, bundleNow: 'missing' })).toBe('hold')
    expect(
      decideServeParkHold(committed, { ...facts, now: committed!.commitDeadlineAt! + 1 })
    ).toBe('release')
  })

  it('releases and names the supervisors that never acknowledged', async () => {
    await register(CHILD)
    let clock = 0
    const result = await parkServeSupervisorsForInstall(
      executable,
      [CHILD],
      deps({
        now: () => clock,
        sleep: async () => {
          clock += 10_000
        }
      })
    )
    expect(result).toEqual({ kind: 'refused', reason: 'unresponsive', pids: [process.pid] })
    expect((await readRecord())?.phase).toBe('unpark')
  })

  it('refuses when a still-blocking server remains after every acknowledgement', async () => {
    await register(CHILD)
    const result = await parkServeSupervisorsForInstall(
      executable,
      [CHILD],
      deps({
        listBlockers: async () => [CHILD],
        ackWaitMs: 50,
        sleep: async () => {
          const record = await readRecord()
          await mkdir(acksDir(dir), { recursive: true })
          await writeFile(join(acksDir(dir), ackFileName(record!.attemptId, process.pid)), '{}')
          await new Promise((r) => setTimeout(r, 20))
        }
      })
    )
    expect(result).toMatchObject({ kind: 'refused', reason: 'unresponsive' })
    expect((await readRecord())?.phase).toBe('unpark')
  })

  it('fails the commit when the park already lapsed, so supervisors are never raced', async () => {
    await register(CHILD)
    await parkServeSupervisorsForInstall(
      executable,
      [CHILD],
      deps({
        sleep: async () => {
          const record = await readRecord()
          await mkdir(acksDir(dir), { recursive: true })
          await writeFile(join(acksDir(dir), ackFileName(record!.attemptId, process.pid)), '{}')
        }
      })
    )
    await expect(
      commitServeSupervisorPark(
        async () => [],
        () => Date.now() + 10 * 60_000
      )
    ).rejects.toThrow()
    expect((await readRecord())?.phase).toBe('unpark')
  })

  it('fails the commit when a server is running again', async () => {
    await register(CHILD)
    await parkServeSupervisorsForInstall(
      executable,
      [CHILD],
      deps({
        sleep: async () => {
          const record = await readRecord()
          await mkdir(acksDir(dir), { recursive: true })
          await writeFile(join(acksDir(dir), ackFileName(record!.attemptId, process.pid)), '{}')
        }
      })
    )
    await expect(commitServeSupervisorPark(async () => [CHILD + 1])).rejects.toThrow()
    expect((await readRecord())?.phase).toBe('unpark')
  })
})
