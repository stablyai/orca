import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  bundleCoordinationDir,
  macCoordinationRoot,
  SERVE_LAUNCHD_LABEL_PREFIX,
  supervisorsDir
} from '../../shared/serve-bundle-coordination'
import {
  commitServeSupervisorPark,
  parkServeSupervisorsForInstall
} from '../../main/updater/serve-supervisor-install-park'
import type * as ServeInstallHold from './serve-install-hold'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
// Why: the real check lists processes for the installer, which the spawn mock cannot answer.
vi.mock('./serve-install-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof ServeInstallHold>()),
  readServeInstallEvidence: async () => ({ kind: 'clear' })
}))

import { serveOrcaApp } from './launch'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  kill = vi.fn((signal: NodeJS.Signals) => {
    queueMicrotask(() => this.emit('exit', null, signal))
  })
  constructor(public pid: number) {
    super()
  }
}

const ENV_KEYS = [
  'HOME',
  'XPC_SERVICE_NAME',
  'ELECTRON_RUN_AS_NODE',
  'ORCA_SERVE_RUNTIME',
  'ORCA_USER_DATA_PATH',
  'ORCA_APP_EXECUTABLE'
] as const

describe.runIf(process.platform === 'darwin')(
  'a parked serve service after a desktop install',
  () => {
    let root: string
    let app: string
    let executable: string
    const savedEnv: Record<string, string | undefined> = {}
    let restoreExecPath: () => void = () => undefined
    let execve: MockInstance<NonNullable<typeof process.execve>>

    async function writeApp(dir: string, version: string): Promise<void> {
      await mkdir(join(dir, 'Contents', 'MacOS'), { recursive: true })
      await writeFile(join(dir, 'Contents', 'MacOS', 'Orca'), '')
      await chmod(join(dir, 'Contents', 'MacOS', 'Orca'), 0o755)
      await writeFile(
        join(dir, 'Contents', 'Info.plist'),
        `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`
      )
    }

    beforeEach(async () => {
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key]
      }
      root = await mkdtemp(join(tmpdir(), 'orca-serve-park-restart-'))
      app = join(root, 'Orca.app')
      executable = join(app, 'Contents', 'MacOS', 'Orca')
      await writeApp(app, '1.0.0')
      // Why HOME: the park records live under the home folder, which must be this test's.
      process.env.HOME = join(root, 'home')
      if (homedir() !== join(root, 'home')) {
        throw new Error('could not isolate the home folder')
      }
      process.env.XPC_SERVICE_NAME = `${SERVE_LAUNCHD_LABEL_PREFIX}.test`
      process.env.ELECTRON_RUN_AS_NODE = '1'
      process.env.ORCA_SERVE_RUNTIME = 'electron'
      process.env.ORCA_USER_DATA_PATH = join(root, 'profile')
      delete process.env.ORCA_APP_EXECUTABLE
      const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')
      Object.defineProperty(process, 'execPath', { configurable: true, value: executable })
      restoreExecPath = () => {
        if (descriptor) {
          Object.defineProperty(process, 'execPath', descriptor)
        }
      }
      // Throwing models a runtime without exec, so the supervisor falls back to spawning here.
      execve = vi.spyOn(process, 'execve').mockImplementation(() => {
        throw new Error('exec recorded')
      })
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      spawnMock.mockReset()
    })

    afterEach(async () => {
      restoreExecPath()
      vi.restoreAllMocks()
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = savedEnv[key]
        }
      }
      await rm(root, { recursive: true, force: true })
    })

    /** Parks the running server like Update & Restart, then installs a new app or only a new plist. */
    async function parkInstallAndResume(replaceExecutable: boolean): Promise<void> {
      const first = new FakeChild(4101)
      const second = new FakeChild(4102)
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
      const service = serveOrcaApp({ supervise: true })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

      const macUserDataRoot = macCoordinationRoot(join(root, 'home'))
      const registration = join(
        supervisorsDir(bundleCoordinationDir(realpathSync(app), macUserDataRoot)),
        `${process.pid}.json`
      )
      await vi.waitFor(
        async () =>
          expect(JSON.parse(await readFile(registration, 'utf8'))).toMatchObject({
            childPid: first.pid
          }),
        { timeout: 5_000 }
      )
      await expect(
        parkServeSupervisorsForInstall(executable, [first.pid], {
          macUserDataRoot,
          listBlockers: async () => []
        })
      ).resolves.toEqual({ kind: 'parked' })
      expect(first.kill).toHaveBeenCalledWith('SIGTERM')
      await commitServeSupervisorPark(async () => [])

      if (replaceExecutable) {
        await writeApp(join(root, 'Update.app'), '1.1.0')
        await rename(app, join(root, 'Previous.app'))
        await rename(join(root, 'Update.app'), app)
        await rm(join(root, 'Previous.app'), { recursive: true })
      } else {
        await writeFile(join(root, 'Info.plist.new'), 'changed')
        await rename(join(root, 'Info.plist.new'), join(app, 'Contents', 'Info.plist'))
      }
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2), { timeout: 10_000 })
      process.emit('SIGTERM', 'SIGTERM')
      await expect(service).resolves.toBe(0)
    }

    it('restarts the supervisor before its next server when the install replaced its executable', async () => {
      await parkInstallAndResume(true)
      expect(execve).toHaveBeenCalledOnce()
      expect(execve.mock.calls[0][0]).toBe(executable)
      expect(execve.mock.invocationCallOrder[0]).toBeLessThan(spawnMock.mock.invocationCallOrder[1])
    }, 20_000)

    it('starts the next server without restarting when its executable was not replaced', async () => {
      await parkInstallAndResume(false)
      expect(execve).not.toHaveBeenCalled()
    }, 20_000)
  }
)
