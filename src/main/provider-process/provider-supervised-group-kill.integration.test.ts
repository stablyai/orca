import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { captureDescendantSnapshot } from '../pty-descendant-termination'
import { supervisedPosixLaunch } from './provider-process-supervisor'
import { killSupervisedProviderGroup } from './provider-supervised-group-kill'

// A provider that ignores stdin end and SIGTERM, with a tool in its own group.
const PROVIDER = String.raw`
  const { spawn } = require('node:child_process')
  process.on('SIGTERM', () => {})
  const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
  process.stdout.write(JSON.stringify({ provider: process.pid, tool: tool.pid }) + '\n')
  setInterval(() => {}, 60000)
`

const spawned = new Set<number>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

async function launch() {
  const spec = supervisedPosixLaunch(
    { command: process.execPath, args: ['-e', PROVIDER] },
    { ...process.env }
  )
  const supervisor = spawnProcess({
    program: spec.command,
    args: spec.args,
    env: spec.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  spawned.add(supervisor.pid!)
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    supervisor.once('exit', (_code, signal) => resolve(signal))
  )
  const pids = await new Promise<{ provider: number; tool: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the provider never reported')), 10_000)
    supervisor.stdout!.once('data', (chunk: Buffer) => {
      clearTimeout(timer)
      resolve(JSON.parse(chunk.toString()))
    })
  })
  spawned.add(pids.provider)
  spawned.add(pids.tool)
  return { supervisor, exited, ...pids }
}

afterEach(() => {
  for (const pid of spawned) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  spawned.clear()
})

describe.runIf(process.platform !== 'win32')('the supervised provider forced kill', () => {
  it("kills the provider and its group, which a SIGKILL to the supervisor alone can't reach", async () => {
    const { supervisor, exited, provider, tool } = await launch()

    const result = await killSupervisedProviderGroup(supervisor, supervisor.pid!, {
      site: 'integration-teardown'
    })

    expect(result.provider).toBe('killed')
    expect(await exited).toBe('SIGKILL')
    expect(await waitFor(() => !alive(provider) && !alive(tool))).toBe(true)
  })

  it('reads a provider that died while the supervisor was paused as gone, not unknown', async () => {
    const { supervisor, exited, provider } = await launch()

    const result = await killSupervisedProviderGroup(supervisor, supervisor.pid!, {
      site: 'integration-teardown',
      captureDescendants: async (rootPid) => {
        const snapshot = await captureDescendantSnapshot(rootPid)
        // The paused supervisor cannot reap it: the group holds a zombie leader and a live tool.
        process.kill(provider, 'SIGKILL')
        return snapshot
      }
    })

    // The live tool still takes the group signal; a zombie-only group answers EPERM on macOS.
    expect(['killed', 'gone']).toContain(result.provider)
    expect(await exited).toBe('SIGKILL')
  })
})
