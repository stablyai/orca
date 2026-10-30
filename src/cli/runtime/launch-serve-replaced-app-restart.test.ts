import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReplacedAppRestart from './serve-replaced-app-restart'
import type * as ServeInstallHold from './serve-install-hold'
import { getServeUpdateHandoffPath } from '../../shared/serve-update-handoff'
import { resetSupervisedServeStop } from './serve-supervised-stop'
import { readServeUpdateHandoff } from './serve-update-supervisor'

const { spawnMock, restartMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  restartMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./serve-replaced-app-restart', async (importOriginal) => ({
  ...(await importOriginal<typeof ReplacedAppRestart>()),
  restartThisServeSupervisorIfReplaced: restartMock
}))

// The spawn mock cannot answer the real installer process check.
vi.mock('./serve-install-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof ServeInstallHold>()),
  readServeInstallEvidence: async () => ({ kind: 'clear' })
}))

import { serveOrcaApp } from './launch'

class FakeChild extends EventEmitter {
  kill = vi.fn()
  constructor(public pid: number) {
    super()
  }
}

const OLD = '1.0.51'
const NEW = '1.0.61'
const ENV_KEYS = [
  'XPC_SERVICE_NAME',
  'ELECTRON_RUN_AS_NODE',
  'ORCA_SERVE_RUNTIME',
  'ORCA_USER_DATA_PATH',
  'ORCA_APP_EXECUTABLE'
] as const

function overrideProperty(key: 'platform' | 'execPath', value: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, key)
  Object.defineProperty(process, key, { configurable: true, value })
  return () => {
    if (descriptor) {
      Object.defineProperty(process, key, descriptor)
    }
  }
}

async function installApp(dir: string, version: string): Promise<void> {
  await mkdir(join(dir, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(dir, 'Contents', 'MacOS', 'Orca'), '')
  await chmod(join(dir, 'Contents', 'MacOS', 'Orca'), 0o755)
  await writeFile(
    join(dir, 'Contents', 'Info.plist'),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
  )
}

describe('serveOrcaApp restarts from a replaced app before any server starts', () => {
  let root: string
  let app: string
  let handoffPath: string
  const restore: (() => void)[] = []
  const savedEnv: Record<string, string | undefined> = {}
  const requested = (servingPid: number) => ({
    schemaVersion: 1 as const,
    phase: 'install-requested' as const,
    fromVersion: OLD,
    targetVersion: NEW,
    servingPid
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-serve-replaced-app-'))
    app = join(root, 'Orca.app')
    await installApp(app, NEW)
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_SERVE_RUNTIME = 'electron'
    process.env.ORCA_USER_DATA_PATH = join(root, 'profile')
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.XPC_SERVICE_NAME
    await mkdir(join(root, 'profile'), { recursive: true })
    handoffPath = getServeUpdateHandoffPath(join(root, 'profile'))
    restore.push(overrideProperty('platform', 'darwin'))
    restore.push(overrideProperty('execPath', join(app, 'Contents', 'MacOS', 'Orca')))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    for (const undo of restore.splice(0).toReversed()) {
      undo()
    }
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    resetSupervisedServeStop()
    vi.restoreAllMocks()
    restartMock.mockReset()
    spawnMock.mockReset()
    await rm(root, { recursive: true, force: true })
  })

  function expectCheckedBeforeEverySpawn(spawns: number): void {
    expect(spawnMock).toHaveBeenCalledTimes(spawns)
    expect(restartMock).toHaveBeenCalledTimes(spawns)
    for (let index = 0; index < spawns; index++) {
      expect(restartMock.mock.invocationCallOrder[index]).toBeLessThan(
        spawnMock.mock.invocationCallOrder[index]
      )
    }
  }

  async function exitForUpdate(): Promise<{ code: Promise<number>; replacement: FakeChild }> {
    const old = new FakeChild(4101)
    const replacement = new FakeChild(4102)
    spawnMock.mockReturnValueOnce(old).mockReturnValueOnce(replacement)
    const code = serveOrcaApp({ json: true })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    await writeFile(handoffPath, JSON.stringify(requested(old.pid)))
    old.emit('exit', 0, null)
    return { code, replacement }
  }

  it('checks before the first server and before the update replacement, keeping the handoff', async () => {
    let stateAtSecondCheck: unknown
    restartMock.mockImplementation(() => {
      if (spawnMock.mock.calls.length === 1) {
        stateAtSecondCheck = readServeUpdateHandoff(handoffPath)
      }
    })
    const { code, replacement } = await exitForUpdate()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    await expect(stateAtSecondCheck).resolves.toMatchObject({ phase: 'install-requested' })
    replacement.emit('exit', 0, null)
    await expect(code).resolves.toBe(1)
    expectCheckedBeforeEverySpawn(2)
  })

  it('neither restarts nor spawns a replacement once a stop is pending', async () => {
    resetSupervisedServeStop(async () => false)
    const { code } = await exitForUpdate()
    await expect(code).resolves.toBe(0)
    expectCheckedBeforeEverySpawn(1)
  })

  it('checks before the server a resumed update starts', async () => {
    await writeFile(handoffPath, JSON.stringify(requested(4101)))
    const replacement = new FakeChild(4102)
    spawnMock.mockReturnValueOnce(replacement)
    const code = serveOrcaApp({ json: true })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    replacement.emit('exit', 0, null)
    await code
    expectCheckedBeforeEverySpawn(1)
  })

  it('does not restart when serving an executable other than its own', async () => {
    process.env.ORCA_APP_EXECUTABLE = join(app, 'Contents', 'MacOS', 'Orca')
    restore.push(overrideProperty('execPath', join(root, 'node')))
    const { code, replacement } = await exitForUpdate()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    replacement.emit('exit', 0, null)
    await expect(code).resolves.toBe(1)
    expect(restartMock).not.toHaveBeenCalled()
  })

  async function withRealRestart() {
    const actual = await vi.importActual<typeof ReplacedAppRestart>('./serve-replaced-app-restart')
    restartMock.mockImplementation(actual.restartThisServeSupervisorIfReplaced)
    // Throwing models a runtime without exec, so the supervisor falls back to spawning here.
    return vi.spyOn(process, 'execve').mockImplementation(() => {
      throw new Error('exec recorded')
    })
  }

  async function swapInstall(version: string): Promise<void> {
    await installApp(join(root, 'Update.app'), version)
    await rename(app, join(root, 'Previous.app'))
    await rename(join(root, 'Update.app'), app)
  }

  async function resumeAcrossInstall(swapDuringWait: boolean) {
    const execve = await withRealRestart()
    if (swapDuringWait) {
      await installApp(app, OLD)
    }
    await writeFile(handoffPath, JSON.stringify(requested(4101)))
    const replacement = new FakeChild(4102)
    spawnMock.mockReturnValueOnce(replacement)
    const code = serveOrcaApp({ json: true })
    if (swapDuringWait) {
      await swapInstall(NEW)
    }
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    replacement.emit('message', { type: 'orca:serve-ready', version: NEW, runtimeId: 'new' })
    await vi.waitFor(async () => expect(await readServeUpdateHandoff(handoffPath)).toBeNull())
    replacement.emit('exit', 0, null)
    await expect(code).resolves.toBe(0)
    return execve
  }

  it('restarts a resumed supervisor whose executable the install replaced while it waited', async () => {
    const execve = await resumeAcrossInstall(true)
    expect(execve).toHaveBeenCalledOnce()
    expect(execve.mock.calls[0][0]).toBe(process.execPath)
    expect(execve.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[0])
  })

  it('resumes without restarting when already on the installed executable, as after a restart', async () => {
    expect(await resumeAcrossInstall(false)).not.toHaveBeenCalled()
  })

  it('restarts before a supervised service starts its next server from a replaced app', async () => {
    const execve = await withRealRestart()
    const crashed = new FakeChild(4101)
    const next = new FakeChild(4102)
    spawnMock.mockReturnValueOnce(crashed).mockReturnValueOnce(next)
    const service = serveOrcaApp({ supervise: true })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    await swapInstall(NEW)
    crashed.emit('exit', 1, null)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    expect(execve).toHaveBeenCalledOnce()
    expect(execve.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[1])
    process.emit('SIGTERM', 'SIGTERM')
    next.emit('exit', null, 'SIGTERM')
    await expect(service).resolves.toBe(0)
  }, 20_000)
})
