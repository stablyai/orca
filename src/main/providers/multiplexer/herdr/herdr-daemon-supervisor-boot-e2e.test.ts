import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdtempSync } from 'node:fs'
import { HerdrDaemonSupervisor } from './herdr-daemon-supervisor'
import { HerdrTransport } from './herdr-transport'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: proves the supervisor boots the REAL daemon entry over the REAL socket
// (no mocks), isolating whether the app's "backend=herdr but no daemon" is a
// supervisor problem or a wiring problem upstream.
describe('herdr daemon supervisor boots the real daemon entry', () => {
  const origXdg = process.env.XDG_RUNTIME_DIR
  const origHome = process.env.HOME
  const origHerdrDataDir = process.env.HERDR_DATA_DIR
  let dir = ''
  let supervisor: HerdrDaemonSupervisor | null = null

  afterEach(async () => {
    process.env.XDG_RUNTIME_DIR = origXdg
    process.env.HOME = origHome
    restoreHerdrTestDataDir(origHerdrDataDir)
    await supervisor?.stop()
    supervisor = null
  })

  it('reaches ready and answers ping through the real socket', async () => {
    dir = mkdtempSync(join(tmpdir(), 'herdr-supervisor-boot-'))
    process.env.HOME = dir
    process.env.XDG_RUNTIME_DIR = dir
    setHerdrTestDataDir(dir)
    const socketPath = join(dir, 'herdr-daemon.sock')
    const entryPath = resolve('out/main/herdr-daemon-entry.js')

    supervisor = new HerdrDaemonSupervisor({
      entryPath,
      runtimeDir: dir,
      socketPath,
      startBudgetMs: 15_000
    })
    supervisor.start()
    await supervisor.onceReady()

    expect(existsSync(socketPath)).toBe(true)

    const transport = new HerdrTransport(socketPath)
    await transport.connect()
    await expect(transport.request('ping', {})).resolves.toEqual({ ok: true })
    await transport.close()
  })
})
