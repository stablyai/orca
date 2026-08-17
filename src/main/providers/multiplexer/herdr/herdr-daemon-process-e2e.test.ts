import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Store } from '../../../persistence'
import { HerdrDaemonHostTransport } from './herdr-daemon-host-transport'
import { HerdrPtyProvider } from './herdr-pty-provider'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'
import {
  herdrTestDataDir,
  restoreHerdrTestDataDir,
  setHerdrTestDataDir
} from './herdr-daemon-test-env'

// Why: certifies the production process path the app uses with the herdr
// backend selected: the daemon as a real child process (the same bundled
// entry the supervisor forks), a real unix socket, a real login shell, and
// the provider stack the app drives. XDG_RUNTIME_DIR + HOME are redirected so
// the test never touches the user's real daemon socket or session state.
describe('herdr terminal through the daemon child process (production path)', () => {
  const originalHome = process.env.HOME
  const originalXdg = process.env.XDG_RUNTIME_DIR
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let dir = ''
  let socketPath = ''
  let daemon: ChildProcess | null = null
  let transport: HerdrDaemonHostTransport | null = null

  async function setup(): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'herdr-process-e2e-'))
    socketPath = join(dir, 'herdr-daemon.sock')
    const childEnv = {
      ...process.env,
      HOME: dir,
      XDG_RUNTIME_DIR: dir,
      HERDR_DATA_DIR: herdrTestDataDir(dir),
      ORCA_APP_VERSION: 'e2e'
    }
    daemon = spawn(process.execPath, ['out/main/herdr-daemon-entry.js', 'daemon'], {
      env: childEnv,
      stdio: 'ignore'
    })
    process.env.HOME = dir
    process.env.XDG_RUNTIME_DIR = dir
    setHerdrTestDataDir(dir)
    const deadline = Date.now() + 15_000
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!existsSync(socketPath)) {
      throw new Error('daemon socket did not appear')
    }
    transport = new HerdrDaemonHostTransport(socketPath)
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.XDG_RUNTIME_DIR = originalXdg
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await transport?.disconnect()
    transport = null
    daemon?.kill('SIGTERM')
    daemon = null
  })

  it('spawns, echoes input, and reports a live pane through the real daemon process', async () => {
    await setup()
    const store = {
      getSettings: () => ({ terminalBackendDefault: 'herdr' }),
      getProjects: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    } as unknown as Store
    const provider = new HerdrPtyProvider(
      () => transport!,
      createLocalHerdrPtyTargetResolver(store),
      () => undefined
    )

    const cwd = dir
    const spawned = await provider.spawn({
      cols: 100,
      rows: 40,
      cwd,
      worktreeId: `repo-1::${cwd}`,
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    expect(spawned.id).toBeTruthy()

    provider.write(spawned.id, 'echo HERDR_PROCESS_E2E\r')

    const deadline = Date.now() + 10_000
    let snapshot: string | null = null
    while (Date.now() < deadline) {
      const buffer = await provider.getBufferSnapshot(spawned.id, { scrollbackRows: 500 })
      if (buffer && buffer.data.includes('HERDR_PROCESS_E2E')) {
        snapshot = buffer.data
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(snapshot).toBeTruthy()
    expect(snapshot).toContain('HERDR_PROCESS_E2E')

    const processes = await provider.listProcesses()
    expect(processes.some((process) => process.id === spawned.id)).toBe(true)

    await provider.shutdown(spawned.id, {})
  })
})
