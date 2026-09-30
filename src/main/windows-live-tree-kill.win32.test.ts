import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../shared/app-environment'
import { setProcessTreeKillGate } from '../shared/child-process/process-tree-kill-gate'
import { signalProcessTree } from '../shared/child-process/process-tree-termination'
import { removeTreeSync } from '../shared/windows-transient-lock-removal'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from './crash-reporting/self-initiated-tree-kill-log'
import { installMainProcessTreeKillGate } from './own-chromium-tree-kill-guard'
import { terminateWindowsProcessTree } from './windows-process-tree-kill'

/**
 * The unit tests pin the gate's decision against a mocked `taskkill`; this pins
 * what that decision does to real Windows processes.
 *
 * Both are needed. Every claim the gate makes is about a mechanism the mocks
 * cannot show: that `taskkill /T /F` actually reaps a detached grandchild, that
 * a refusal actually leaves that tree standing, and that the handle-addressed
 * root kill the refusal path falls back to actually reaps the root while
 * orphaning its descendants — the asymmetry the PR discloses rather than fixes.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

/** Read live by the guard on every kill, so a case can flip it mid-test. */
let orcaChromiumPids: number[] = []

function appEnvironment(): AppEnvironment {
  return {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-live',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: (() =>
      orcaChromiumPids.map((pid) => ({
        pid,
        type: 'Tab'
      }))) as unknown as AppEnvironment['getAppMetrics']
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await sleep(100)
  }
  return predicate()
}

let markerDirectory = ''
let markerSequence = 0
const spawnedRoots: ChildProcess[] = []
const spawnedLeaves: number[] = []
const observedSpawns: ChildProcess[] = []

function observeSpawn(message: unknown): void {
  if (
    typeof message === 'object' &&
    message !== null &&
    'process' in message &&
    message.process instanceof ChildProcess
  ) {
    observedSpawns.push(message.process)
  }
}

/** A real root with a real grandchild; the grandchild reports its pid on disk. */
async function spawnLiveTree(): Promise<{
  child: ChildProcess
  rootPid: number
  leafPid: number
}> {
  const marker = join(markerDirectory, `leaf-${markerSequence++}.pid`)
  const leafSource = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 600000)`
  // Non-detached Windows children can die with the root's libuv Job Object.
  const rootSource = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leafSource)}], { stdio: 'ignore', detached: true, windowsHide: true }); setTimeout(() => {}, 600000)`
  const child = spawn(process.execPath, ['-e', rootSource], {
    stdio: 'ignore',
    windowsHide: true
  })
  spawnedRoots.push(child)
  const rootPid = child.pid as number
  expect(rootPid).toBeGreaterThan(0)
  expect(await waitFor(() => existsSync(marker))).toBe(true)
  const leafPid = Number(readFileSync(marker, 'utf8'))
  spawnedLeaves.push(leafPid)
  expect(await waitFor(() => isAlive(leafPid))).toBe(true)
  return { child, rootPid, leafPid }
}

describeOnWindows('own-Chromium gate against real Windows process trees', () => {
  beforeEach(() => {
    markerDirectory ||= mkdtempSync(join(tmpdir(), 'orca-live-tree-kill-'))
    resetSelfInitiatedTreeKillLogForTest()
    orcaChromiumPids = []
    setAppEnvironment(appEnvironment())
    installMainProcessTreeKillGate()
    observedSpawns.length = 0
    subscribe('child_process', observeSpawn)
  })

  afterEach(async () => {
    unsubscribe('child_process', observeSpawn)
    orcaChromiumPids = []
    for (const leafPid of spawnedLeaves.splice(0)) {
      await terminateWindowsProcessTree(leafPid, { site: 'live-tree-kill-cleanup' })
    }
    for (const root of spawnedRoots.splice(0)) {
      root.kill('SIGKILL')
    }
    setProcessTreeKillGate(null)
  })

  afterAll(() => {
    if (markerDirectory) {
      removeTreeSync(markerDirectory)
    }
  })

  it('admitted: taskkill reaps the root and its detached grandchild, and the kill is recorded', async () => {
    const { rootPid, leafPid } = await spawnLiveTree()

    await terminateWindowsProcessTree(rootPid, { site: 'live-tree-kill-admit' })

    expect(await waitFor(() => !isAlive(rootPid))).toBe(true)
    expect(await waitFor(() => !isAlive(leafPid))).toBe(true)
    expect(
      findSelfInitiatedTreeKills(Date.now()).some(
        (kill) => kill.pid === rootPid && kill.site === 'live-tree-kill-admit'
      )
    ).toBe(true)
  })

  it('refused: the tree survives, nothing is recorded, and the handle kill still reaps the root', async () => {
    const { child, rootPid, leafPid } = await spawnLiveTree()
    orcaChromiumPids = [rootPid]

    await terminateWindowsProcessTree(rootPid, { site: 'live-tree-kill-refuse' })

    await sleep(1_000)
    expect(isAlive(rootPid)).toBe(true)
    expect(isAlive(leafPid)).toBe(true)
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([])

    // The fallback every gated site runs after a refusal.
    child.kill('SIGKILL')
    expect(await waitFor(() => !isAlive(rootPid))).toBe(true)
    // Let root-owned job cleanup finish before asserting independent survival.
    await sleep(250)
    // Disclosed asymmetry: a refusal orphans descendants rather than reaping them.
    expect(isAlive(leafPid)).toBe(true)
  })

  it('signalProcessTree refused: the root goes by handle and the barrier reports unverified', async () => {
    const { child, rootPid, leafPid } = await spawnLiveTree()
    orcaChromiumPids = [rootPid]
    observedSpawns.length = 0

    await expect(signalProcessTree(child, 'SIGKILL')).resolves.toBe(false)

    expect(observedSpawns).toHaveLength(0)
    expect(await waitFor(() => !isAlive(rootPid))).toBe(true)
    await sleep(250)
    expect(isAlive(leafPid)).toBe(true)
  })

  it('signalProcessTree admitted: the whole tree goes and the barrier reports verified', async () => {
    const { child, rootPid, leafPid } = await spawnLiveTree()
    observedSpawns.length = 0

    await expect(signalProcessTree(child, 'SIGKILL')).resolves.toBe(true)

    expect(observedSpawns.map((child) => child.spawnfile)).toEqual(['taskkill'])
    expect(await waitFor(() => !isAlive(rootPid))).toBe(true)
    expect(await waitFor(() => !isAlive(leafPid))).toBe(true)
  })
})
