import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import type * as SupervisorRelocation from './serve-supervisor-relocation'
import { getServeUpdateHandoffPath } from '../../shared/serve-update-handoff'
import { resetSupervisedServeStop } from './serve-supervised-stop'
import { restartServeSupervisorIfReplaced } from './serve-supervisor-relocation'
import { readServeUpdateHandoff } from './serve-update-handoff-file'
import { resumeInterruptedServeUpdate, superviseForegroundServe } from './serve-update-supervisor'

const { spawnMock, restartMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  restartMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./serve-supervisor-relocation', async (importOriginal) => ({
  ...(await importOriginal<typeof SupervisorRelocation>()),
  restartThisServeSupervisorIfReplaced: restartMock
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

function plist(version: string): string {
  return `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
}

function overrideProperty(key: 'platform' | 'execPath', value: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, key)
  Object.defineProperty(process, key, { configurable: true, value })
  return () => {
    if (descriptor) {
      Object.defineProperty(process, key, descriptor)
    }
  }
}

describe('supervisor restart after a macOS update', () => {
  let root: string
  let executable: string
  let handoffPath: string
  let restorePlatform: () => void

  const handoff = { schemaVersion: 1 as const, phase: 'install-requested' as const }
  const requested = (servingPid: number) => ({
    ...handoff,
    fromVersion: OLD,
    targetVersion: NEW,
    servingPid
  })

  beforeEach(async () => {
    restorePlatform = overrideProperty('platform', 'darwin')
    root = await mkdtemp(join(tmpdir(), 'orca-serve-update-restart-'))
    executable = join(root, 'Orca.app', 'Contents', 'MacOS', 'Orca')
    await mkdir(join(root, 'Orca.app', 'Contents', 'MacOS'), { recursive: true })
    // The update is already on disk when the old child exits.
    await writeFile(join(root, 'Orca.app', 'Contents', 'Info.plist'), plist(NEW))
    handoffPath = join(root, 'handoff.json')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    restorePlatform()
    resetSupervisedServeStop()
    vi.restoreAllMocks()
    restartMock.mockReset()
    spawnMock.mockReset()
    await rm(root, { recursive: true, force: true })
  })

  async function exitForUpdate(
    restart: (() => void) | null,
    replacement = new FakeChild(4102)
  ): Promise<{ code: Promise<number>; spawnChild: ReturnType<typeof vi.fn> }> {
    const old = new FakeChild(4101)
    await writeFile(handoffPath, JSON.stringify(requested(old.pid)))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeChild implements every handle member the supervisor calls.
    const spawnChild = vi.fn(() => replacement as unknown as ChildProcessHandle)
    const code = superviseForegroundServe({
      spec: { program: executable },
      spawnChild,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      child: old as unknown as ChildProcessHandle,
      handoffPath,
      expectedHandoff: null,
      restartIfReplaced: restart
    })
    old.emit('exit', 0, null)
    return { code, spawnChild }
  }

  function serveReady(replacement: FakeChild): void {
    replacement.emit('message', {
      type: 'orca:serve-ready',
      version: NEW,
      runtimeId: 'runtime-new'
    })
  }

  it('restarts from the installed app before any replacement, keeping the handoff, and spawns only if that returns', async () => {
    const replacement = new FakeChild(4102)
    let stateAtRestart: unknown
    let spawnsAtRestart = -1
    const { code, spawnChild } = await exitForUpdate(() => {
      stateAtRestart = readServeUpdateHandoff(handoffPath)
      spawnsAtRestart = spawnChild.mock.calls.length
    }, replacement)
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledOnce())

    expect(spawnsAtRestart).toBe(0)
    await expect(stateAtRestart).resolves.toMatchObject({ phase: 'install-requested' })
    serveReady(replacement)
    await vi.waitFor(async () => expect(await readServeUpdateHandoff(handoffPath)).toBeNull())
    replacement.emit('exit', 0, null)
    await expect(code).resolves.toBe(0)
  })

  it('neither restarts nor spawns once a stop is pending', async () => {
    resetSupervisedServeStop(async () => false)
    const restart = vi.fn()
    const { code, spawnChild } = await exitForUpdate(restart)
    await expect(code).resolves.toBe(0)
    expect(restart).not.toHaveBeenCalled()
    expect(spawnChild).not.toHaveBeenCalled()
  })

  it('keeps spawning the replacement directly where no restart applies', async () => {
    const replacement = new FakeChild(4102)
    const { code, spawnChild } = await exitForUpdate(null, replacement)
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledOnce())
    replacement.emit('exit', 0, null)
    await expect(code).resolves.toBe(1)
  })

  // The real decision: restart only if the install replaced the executable this process started on.
  async function resumeWithRealRestart(swapDuringWait: boolean) {
    const install = async (dir: string, version: string): Promise<void> => {
      await mkdir(join(dir, 'Contents', 'MacOS'), { recursive: true })
      await writeFile(join(dir, 'Contents', 'MacOS', 'Orca'), '')
      await chmod(join(dir, 'Contents', 'MacOS', 'Orca'), 0o755)
      await writeFile(join(dir, 'Contents', 'Info.plist'), plist(version))
    }
    const identify = (path: string): string | null => {
      try {
        const stats = statSync(path)
        return `${stats.dev}:${stats.ino}`
      } catch {
        return null
      }
    }
    await install(join(root, 'Orca.app'), swapDuringWait ? OLD : NEW)
    const cliEntry = join(root, 'cli.js')
    await writeFile(cliEntry, '')
    await writeFile(handoffPath, JSON.stringify(requested(4101)))
    const startedFrom = identify(executable)
    const execve = vi.fn()
    const replacement = new FakeChild(4102)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeChild implements every handle member the supervisor calls.
    const spawnChild = vi.fn(() => replacement as unknown as ChildProcessHandle)
    const code = resumeInterruptedServeUpdate({
      spec: { program: executable },
      spawnChild,
      handoffPath,
      handoff: requested(4101),
      restartIfReplaced: () =>
        restartServeSupervisorIfReplaced({
          env: {},
          execPath: executable,
          execArgv: [],
          argv: ['/ignored', cliEntry, 'serve'],
          appRoot: root,
          pid: 4242,
          execve,
          log: vi.fn(),
          startedFrom,
          identify,
          canExecute: () => true
        })
    })
    if (swapDuringWait) {
      await install(join(root, 'Update.app'), NEW)
      await rename(join(root, 'Orca.app'), join(root, 'Previous.app'))
      await rename(join(root, 'Update.app'), join(root, 'Orca.app'))
    }
    // A mocked execve returns, so the replacement still starts and settles the handoff.
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledOnce())
    serveReady(replacement)
    await vi.waitFor(async () => expect(await readServeUpdateHandoff(handoffPath)).toBeNull())
    replacement.emit('exit', 0, null)
    await expect(code).resolves.toBe(0)
    return { execve, spawnChild }
  }

  it('restarts a resumed supervisor whose executable the install replaced while it waited', async () => {
    const { execve, spawnChild } = await resumeWithRealRestart(true)
    expect(execve).toHaveBeenCalledOnce()
    expect(execve.mock.invocationCallOrder[0]).toBeLessThan(spawnChild.mock.invocationCallOrder[0])
  })

  it('resumes without restarting when already on the installed executable, as after a restart', async () => {
    const { execve } = await resumeWithRealRestart(false)
    expect(execve).not.toHaveBeenCalled()
  })

  describe('serveOrcaApp', () => {
    let restoreExecPath: () => void
    const savedEnv = { ...process.env }

    beforeEach(async () => {
      restoreExecPath = overrideProperty('execPath', executable)
      process.env.ELECTRON_RUN_AS_NODE = '1'
      process.env.ORCA_SERVE_RUNTIME = 'electron'
      process.env.ORCA_USER_DATA_PATH = join(root, 'profile')
      delete process.env.ORCA_APP_EXECUTABLE
      await mkdir(join(root, 'profile'), { recursive: true })
    })

    afterEach(() => {
      restoreExecPath()
      for (const key of [
        'ELECTRON_RUN_AS_NODE',
        'ORCA_SERVE_RUNTIME',
        'ORCA_USER_DATA_PATH',
        'ORCA_APP_EXECUTABLE'
      ]) {
        if (savedEnv[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = savedEnv[key]
        }
      }
    })

    async function serveThroughUpdate(): Promise<{ code: Promise<number> }> {
      const old = new FakeChild(4101)
      const replacement = new FakeChild(4102)
      spawnMock.mockReturnValueOnce(old).mockReturnValueOnce(replacement)
      const code = serveOrcaApp({ json: true })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      await writeFile(
        getServeUpdateHandoffPath(join(root, 'profile')),
        JSON.stringify(requested(old.pid))
      )
      old.emit('exit', 0, null)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      replacement.emit('exit', 0, null)
      return { code }
    }

    it('restarts a supervisor running on the updated app', async () => {
      await expect((await serveThroughUpdate()).code).resolves.toBe(1)
      // Before the first server, then again once the install has landed.
      expect(restartMock).toHaveBeenCalledTimes(2)
      expect(restartMock).toHaveBeenCalledWith(expect.any(String))
    })

    it('does not restart when serving an executable other than its own', async () => {
      process.env.ORCA_APP_EXECUTABLE = executable
      restoreExecPath()
      restoreExecPath = overrideProperty('execPath', join(root, 'node'))
      await expect((await serveThroughUpdate()).code).resolves.toBe(1)
      expect(restartMock).not.toHaveBeenCalled()
    })
  })
})
