import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import type { Store } from '../../../persistence'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { HerdrDaemonHostTransport } from './herdr-daemon-host-transport'
import { HerdrPtyProvider } from './herdr-pty-provider'
import { createLocalHerdrPtyTargetResolver } from './herdr-project-pty-target'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: the full renderer round trip — provider.spawn over the daemon host
// transport, provider.write (renderer input), a real login shell echo, and
// buffer delivery back through pane.read — all with a real node-pty.
describe('herdr terminal input end to end (real PTY)', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let transport: HerdrDaemonHostTransport | null = null

  async function setup(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-input-e2e-'))
    const socketPath = join(dir, 'herdr.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    daemon = new HerdrDaemon(server)
    await server.startServer()
    transport = new HerdrDaemonHostTransport(socketPath)
    return socketPath
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await transport?.disconnect()
    transport = null
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('echoes renderer input back through the pane buffer', async () => {
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

    const cwd = process.env.HOME!
    const spawned = await provider.spawn({
      cols: 100,
      rows: 40,
      cwd,
      worktreeId: `repo-1::${cwd}`,
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })
    expect(spawned.id).toBeTruthy()

    provider.write(spawned.id, 'echo ORCA_INPUT_E2E\r')

    const deadline = Date.now() + 10_000
    let snapshot: string | null = null
    while (Date.now() < deadline) {
      const buffer = await provider.getBufferSnapshot(spawned.id, { scrollbackRows: 500 })
      if (buffer && buffer.data.includes('ORCA_INPUT_E2E')) {
        snapshot = buffer.data
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(snapshot).toBeTruthy()
    expect(snapshot).toContain('ORCA_INPUT_E2E')

    await provider.shutdown(spawned.id, {})
  })

  it('streams incremental pane.data frames through the daemon transport', async () => {
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

    const cwd = process.env.HOME!
    const spawned = await provider.spawn({
      cols: 100,
      rows: 40,
      cwd,
      worktreeId: `repo-1::${cwd}`,
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1'
    })

    // Why: the daemon controller streams raw PTY bytes as incremental frames
    // after one seed snapshot. The seed is returned as `spawned.snapshot`, never
    // re-emitted through onData, so a keystroke must surface as a small delta.
    const chunks: string[] = []
    provider.onData((payload) => {
      if (payload.id === spawned.id) {
        chunks.push(payload.data)
      }
    })

    provider.write(spawned.id, 'echo ORCA_STREAM_E2E\r')

    const deadline = Date.now() + 10_000
    let stream = ''
    while (Date.now() < deadline) {
      stream = chunks.join('')
      if (stream.includes('ORCA_STREAM_E2E')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(stream).toContain('ORCA_STREAM_E2E')

    await provider.shutdown(spawned.id, {})
  })
})
