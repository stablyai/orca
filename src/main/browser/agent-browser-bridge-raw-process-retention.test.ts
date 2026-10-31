import * as childProcess from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { current: '' } }))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataPath.current),
    getAppPath: vi.fn(() => userDataPath.current),
    isPackaged: false
  }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

import { AgentBrowserBridge } from './agent-browser-bridge'
import { mockBrowserManager } from './agent-browser-bridge-test-harness'

let bridge: AgentBrowserBridge

beforeEach(() => {
  vi.clearAllMocks()
  userDataPath.current = mkdtempSync(join(tmpdir(), 'orca-agent-browser-retention-'))
  bridge = new AgentBrowserBridge(mockBrowserManager())
  Object.defineProperty(bridge, 'agentBrowserBin', { value: process.execPath, configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(userDataPath.current, { recursive: true, force: true })
})

function run(script: string): Promise<string> {
  return bridge['runAgentBrowserRaw']('orca-tab-retention', ['-e', script])
}

function rememberChild(script: string) {
  const spawn = vi.mocked(childProcess.execFile)
  const pending = run(script)
  const result = spawn.mock.results[0]
  if (result?.type !== 'return') {
    throw new Error('Expected a real helper process')
  }
  const child = new WeakRef(result.value)
  // Mock call records must not keep the completed helper alive.
  spawn.mockClear()
  return { pending, child }
}

async function collect(): Promise<void> {
  if (!global.gc) {
    throw new Error('This retention test requires --expose-gc')
  }
  for (let turn = 0; turn < 5; turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    global.gc()
  }
}

it('releases the completed helper before the fallback deadline while its bridge stays usable', async () => {
  const { pending, child } = rememberChild("process.stdout.write('complete')")
  expect(await pending).toBe('complete')
  await collect()
  expect(child.deref()).toBeUndefined()
  expect(await run("process.stdout.write('next')")).toBe('next')
})
