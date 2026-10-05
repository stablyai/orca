import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: '' } }))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataPath.current),
    getAppPath: vi.fn(() => userDataPath.current),
    isPackaged: false
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import { mockBrowserManager } from './agent-browser-bridge-test-harness'

const PAYLOAD_BYTES = 5 * 1024 * 1024

// Why: reproduces vercel-labs/agent-browser#1407 on every platform: a detached grandchild keeps
// the helper's stdout/stderr pipes open after the helper itself has written its JSON and exited.
const HELPER_WITH_LINGERING_DAEMON = `
const { spawn } = require('node:child_process')
const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
  stdio: 'inherit',
  detached: true
})
daemon.unref()
process.stdout.write(JSON.stringify({ daemonPid: daemon.pid, payload: 'x'.repeat(${PAYLOAD_BYTES}) }))
`

describe('AgentBrowserBridge raw helper process', () => {
  afterEach(() => {
    rmSync(userDataPath.current, { recursive: true, force: true })
  })

  it('settles on helper exit with full output while a descendant still holds the pipes', async () => {
    userDataPath.current = mkdtempSync(join(tmpdir(), 'orca-agent-browser-raw-'))
    const bridge = new AgentBrowserBridge(mockBrowserManager())
    Object.defineProperty(bridge, 'agentBrowserBin', { value: process.execPath })

    const stdout = await bridge['runAgentBrowserRaw']('orca-tab-raw', [
      '-e',
      HELPER_WITH_LINGERING_DAEMON
    ])
    const output: { daemonPid: number; payload: string } = JSON.parse(stdout)
    try {
      expect(output.payload).toHaveLength(PAYLOAD_BYTES)
    } finally {
      process.kill(output.daemonPid)
    }
  }, 10_000)
})
