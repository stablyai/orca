import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type * as WorktreeScanCache from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListing from '../../../git/worktrees/catalog/worktree-listing'
import { settledWriteStub } from '../../../providers/testing/settled-pty-write-stub'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { committingSpawn } from '../../../runtime/orca-runtime-tests/bind-first-pane.test-fixture'
import { AGENT_LAUNCH_METHODS } from '../../../runtime/rpc/methods/agent-launch/agent-launch'
import { makeStore } from '../../../runtime/rpc/server/runtime-rpc-worktree-store-fixtures'
import { pluginRuntimeRpc } from '../../plugin-runtime-rpc'
import { executePluginHostCall } from './plugin-host-methods'
import { bindPluginHostServices } from './plugin-host-service-bindings'
import { PluginWorkerHostCalls } from '../parent-process/plugin-worker-host-calls'
import { pluginHostCallRevoked } from './plugin-host-call-scope'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const { createWorktreeListingMocks } =
    await import('../../../runtime/rpc/server/runtime-rpc-worktree-store-fixtures')
  return {
    ...(await importOriginal<typeof WorktreeScanCache>()),
    listWorktrees: createWorktreeListingMocks().listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const { createWorktreeListingMocks } =
    await import('../../../runtime/rpc/server/runtime-rpc-worktree-store-fixtures')
  return {
    ...(await importOriginal<typeof WorktreeListing>()),
    listWorktreesStrict: createWorktreeListingMocks().listWorktreesStrict
  }
})

const PTY_ID = 'plugin-agent-pty'
const PROMPT = 'Complete the Meego handoff.'
const COMPOSER = readFileSync(
  join(__dirname, '../../../runtime/__fixtures__/zcode-composer-ready.txt'),
  'utf8'
)

function coldLaunch() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the repo/worktree storage used by terminal creation.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const logs: string[] = []
  let ready = false
  let approved = true
  const writes: { ptyId: string; text: string }[] = []
  const write = (ptyId: string, text: string) => {
    writes.push({ ptyId, text })
    return true
  }
  const foreground = () => (ready ? 'zcode-cli' : 'zsh')
  runtime.setPtyController({
    spawn: committingSpawn(runtime, async () => ({
      id: PTY_ID,
      incarnationId: 'plugin-agent-incarnation'
    })),
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => foreground(),
    supportsForegroundObservation: () => true,
    inspectProcess: async () => ({
      foregroundProcess: foreground(),
      hasChildProcesses: ready,
      foregroundObservation: {
        ptyId: PTY_ID,
        ptyIncarnationId: 'plugin-agent-incarnation',
        authorityGeneration: 'plugin-agent-owner',
        observationEpoch: ready ? 2 : 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: ready ? 'non-shell' : 'shell',
        processName: ready ? 'zcode-cli' : 'zsh'
      }
    })
  })
  const services = bindPluginHostServices({
    pluginsDataDir: '/unused-plugin-agent-test-data',
    delegate: {
      resolveActiveWorktreeContext: () => runtime.resolveActiveWorktreeContext(),
      listTerminals: (...args) => runtime.listTerminals(...args),
      sendTerminal: (...args) => runtime.sendTerminal(...args),
      dispatchPluginNotification: async () => ({ delivered: true }),
      callRuntime: pluginRuntimeRpc(runtime, AGENT_LAUNCH_METHODS)
    }
  })
  return {
    runtime,
    writes,
    logs,
    launch: (signal?: AbortSignal) =>
      executePluginHostCall({
        pluginId: 'test.agent-handoff',
        method: 'agent.launch',
        params: { workspaceId: 'repo-1::/tmp/worktree-a', agent: 'zcode', prompt: PROMPT },
        surface: 'worker',
        grantedCapabilities: ['agent:launch'],
        services,
        audit: { record: async () => {} },
        scope: {
          signal,
          assertActive: () => {
            signal?.throwIfAborted()
            if (!approved) {
              throw pluginHostCallRevoked()
            }
          },
          log: (line) => logs.push(line)
        }
      }),
    revokeApproval: () => {
      approved = false
    },
    showComposer: () => {
      ready = true
      for (let offset = 0; offset < COMPOSER.length; offset += 4096) {
        runtime.onPtyData(PTY_ID, COMPOSER.slice(offset, offset + 4096), Date.now())
      }
    }
  }
}

describe('plugin launch prompt delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('submits once to the new terminal after its cold shell becomes an agent composer', async () => {
    vi.useFakeTimers()
    const launch = coldLaunch()
    const receipt = await launch.launch()
    if (!receipt.ok) {
      throw new Error(receipt.error)
    }
    const { terminalId } = z.object({ terminalId: z.string() }).parse(receipt.value)
    expect(await launch.runtime.showTerminal(terminalId)).toMatchObject({
      ptyId: PTY_ID,
      worktreeId: 'repo-1::/tmp/worktree-a'
    })
    expect(
      await launch.runtime.isTerminalRunningAgent(terminalId, { retryForegroundWrappers: false })
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    launch.showComposer()
    await vi.runAllTimersAsync()

    expect(launch.writes, launch.logs.join('\n')).toEqual([
      { ptyId: PTY_ID, text: '\x1b[200~Complete the Meego handoff.\x1b[201~' },
      { ptyId: PTY_ID, text: '\r' }
    ])
  })

  it('keeps a deferred prompt out of the terminal when its worker exits after the launch receipt', async () => {
    vi.useFakeTimers()
    const launch = coldLaunch()
    const calls = new PluginWorkerHostCalls()
    const receipt = await launch.launch(calls.start(1))
    if (!receipt.ok) {
      throw new Error(receipt.error)
    }
    const { terminalId } = z.object({ terminalId: z.string() }).parse(receipt.value)
    calls.finish(1)
    expect(
      await launch.runtime.isTerminalRunningAgent(terminalId, { retryForegroundWrappers: false })
    ).toBe(false)
    calls.cancelAll()
    launch.showComposer()
    await vi.runAllTimersAsync()

    expect(launch.writes).toEqual([])
  })

  it('refuses deferred prompt delivery when approval is revoked after the launch receipt', async () => {
    vi.useFakeTimers()
    const launch = coldLaunch()
    const receipt = await launch.launch(new AbortController().signal)
    if (!receipt.ok) {
      throw new Error(receipt.error)
    }
    await vi.advanceTimersByTimeAsync(0)
    launch.revokeApproval()
    launch.showComposer()
    await vi.runAllTimersAsync()

    expect(launch.writes).toEqual([])
  })
})
