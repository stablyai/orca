import './mock-descendant-sweep'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as pty from 'node-pty'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadNodePtyForTests } from '../orcad/orcad-node-slot-fixture'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { getHistorySessionDirName } from './history-paths'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const SESSION_ID = 'wt-1::/project@@sleep-cwd'

// verify-15b: a WSL host pane (orcad on Linux) woke in the project root after `cd deep`.
describePosix('a real bash slept and woken by the daemon', () => {
  let nodePty: typeof pty
  let harness: DaemonAdapterHarness | null = null
  let shells: pty.IPty[] = []
  let root = ''
  let adapter: DaemonPtyAdapter | null = null

  beforeAll(async () => {
    nodePty = await loadNodePtyForTests()
  })
  afterEach(async () => {
    for (const shell of shells.splice(0)) {
      try {
        shell.kill('SIGKILL')
      } catch {
        // Already exited.
      }
    }
    adapter?.dispose()
    await harness?.server.shutdown()
    rmSync(harness?.dir ?? '', { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('wakes in the folder bash was in, though bash prints no OSC 7', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-sleep-cwd-')))
    const deep = join(root, 'deep')
    mkdirSync(deep)
    const spawnedCwds: string[] = []
    let output = ''
    harness = await startDaemonAdapterHarness((opts) => {
      const cwd = opts.cwd ?? root
      spawnedCwds.push(cwd)
      const shell = nodePty.spawn('/bin/bash', ['--norc', '--noprofile', '-i'], {
        cwd,
        cols: 80,
        rows: 24,
        env: { TERM: 'xterm-256color', PATH: '/usr/bin:/bin', PS1: 'PROMPT$ ' }
      })
      shell.onData((data) => {
        output += data
      })
      shells.push(shell)
      return createDaemonPtySubprocessHandle({
        process: shell,
        shellPath: '/bin/bash',
        spawnCwd: cwd,
        env: {},
        startupCommandDeliveredInShellArgs: false,
        reportsChildExitStatus: true,
        sessionId: SESSION_ID,
        startupAgentRecognition: null
      })
    })
    const historyDir = join(harness.dir, 'history')
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: historyDir
    })

    await adapter.spawn({ cols: 80, rows: 24, cwd: root, sessionId: SESSION_ID })
    await vi.waitFor(() => expect(output).toContain('PROMPT$'), { timeout: 5000 })
    adapter.write(SESSION_ID, 'cd deep && echo IN-DEEP\n')
    await vi.waitFor(() => expect(output).toMatch(/IN-DEEP\r?\n/), { timeout: 5000 })

    await adapter.shutdown(SESSION_ID, { immediate: true, keepHistory: true })
    const saved = JSON.parse(
      readFileSync(
        join(historyDir, getHistorySessionDirName(SESSION_ID), 'checkpoint.json'),
        'utf8'
      )
    )
    expect(saved.cwd).toBe(deep)

    await adapter.spawn({ cols: 80, rows: 24, cwd: root, sessionId: SESSION_ID })
    expect(spawnedCwds.at(-1)).toBe(deep)
  })
})
