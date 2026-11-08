import * as supervisedStop from '../provider-process/supervised-child-process-stop'
import { createMockDiscoveryChild } from './commit-message-text-generation-test-harness'
import {
  MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
  SOURCE_CONTROL_GENERATION_TIMEOUT_MS
} from './source-control-generation-limits'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { generateConversationName } from './conversation-name-generation-request'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootOnlyProviderClosePolicy } from '../provider-process/provider-process-close'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import { discoverModelsLocal } from './commit-message-model-discovery'
import { cancelGenerateCommitMessageLocal } from './commit-message-text-generation'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { killSourceControlAgentProcess } from './source-control-local-process'
import { generateCommitMessage } from './source-control-text-generation-requests'
import type {
  SpawnSourceControlAgent,
  SpawnedSourceControlAgentProcess
} from './source-control-text-generation-types'

const { terminateTreeMock } = vi.hoisted(() => ({
  terminateTreeMock: vi.fn(async () => true)
}))

vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: terminateTreeMock
}))

type FakeSupervisor = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  supervised: true
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
}

function fakeSupervisor(exitsOn: NodeJS.Signals | null): FakeSupervisor {
  const child: FakeSupervisor = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    supervised: true as const,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      if (signal === exitsOn) {
        child.signalCode = signal
        child.emit('exit', null, signal)
      }
      return true
    })
  })
  return child
}

// Model supervisor SIGTERM completion after provider cleanup delay.
function fakeSupervisedAgent(stopMs: number): FakeSupervisor & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { on: () => void; end: () => void }
} {
  const child = Object.assign(fakeSupervisor(null), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { on: vi.fn(), end: vi.fn() }
  })
  child.kill.mockImplementation((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
        child.emit('close', null, 'SIGTERM')
      }, stopMs)
    }
    return true
  })
  return child
}

function asSpawned(child: FakeSupervisor): SpawnedSourceControlAgentProcess {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop and the generation read only pid, exit state, kill, the stdio streams and the child events, which the fakes implement.
  return child as unknown as SpawnedSourceControlAgentProcess
}

function withPolicyProbes(spawn: SpawnSourceControlAgent): SpawnSourceControlAgent {
  return (input) => {
    if (!input.args.includes('mcp')) {
      return spawn(input)
    }
    const child = createMockDiscoveryChild()
    child.stdin.end.mockImplementation(() =>
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('[]'))
        child.emit('close', 0)
      })
    )
    return child
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  vi.useRealTimers()
  terminateTreeMock.mockClear()
})

describe('killSourceControlAgentProcess for a supervised agent', () => {
  it('tears the tree down only once the supervisor has had its full stop time', async () => {
    vi.useFakeTimers()
    const child = fakeSupervisor(null)

    const stopped = killSourceControlAgentProcess(asSpawned(child))
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(terminateTreeMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(terminateTreeMock).toHaveBeenCalledWith(child, {
      site: 'source-control-text-generation',
      supervised: true
    })
    await vi.advanceTimersByTimeAsync(rootOnlyProviderClosePolicy(true).forcedExitMs)
    await stopped
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })
})

describe('a supervised agent one-shot that runs out of time', () => {
  it('times out at once but holds the Codex home until the supervisor has stopped', async () => {
    vi.useFakeTimers()
    const stopMs = 2_000
    const agents = [fakeSupervisedAgent(stopMs), fakeSupervisedAgent(stopMs)]
    const spawnAgent = vi.fn(() => asSpawned(agents[spawnAgent.mock.calls.length - 1]!))
    const request = (cwd: string): ReturnType<typeof generateCommitMessage> =>
      generateCommitMessage({
        context: { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        params: { agentId: 'codex', model: 'gpt-5.5' },
        target: { kind: 'local', cwd, env: { CODEX_HOME: '/codex/timeout-home' } },
        spawnAgent: withPolicyProbes(spawnAgent)
      })

    const first = request('/repo/first')
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnAgent).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    await expect(first).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/timed out/)
    })
    expect(agents[0]!.kill.mock.calls).toEqual([['SIGTERM']])

    const second = request('/repo/second')
    await vi.advanceTimersByTimeAsync(stopMs - 1)
    expect(spawnAgent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnAgent).toHaveBeenCalledTimes(2)

    agents[1]!.stdout.emit('data', Buffer.from('Update README\n'))
    agents[1]!.emit('close', 0)
    await expect(second).resolves.toMatchObject({ success: true, message: 'Update README' })
    expect(agents[0]!.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(terminateTreeMock).not.toHaveBeenCalled()
  })
})

describe('context-owned one-shot settlement', () => {
  it.each(['timeout', 'cancel', 'error', 'stdin', 'overflow', 'exit-first', 'reject-cleanup'])(
    'owns terminal evidence and cleanup after %s',
    async (route) => {
      vi.useFakeTimers()
      const child = Object.assign(createMockDiscoveryChild(), { supervised: true as const })
      const stop = supervisedStop.stopSupervisedChildProcess
      const cleanup = Promise.withResolvers<void>()
      const stopping = vi
        .spyOn(supervisedStop, 'stopSupervisedChildProcess')
        .mockImplementation(async (...args) => {
          const result = await stop(...args)
          await cleanup.promise
          if (route === 'reject-cleanup') {
            throw new Error('Cleanup refused')
          }
          return result
        })
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        if (route === 'stdin') {
          child.stdin.end.mockImplementation(() => {
            throw new Error('Broken input')
          })
        }
        let settled = false
        const request = generateConversationName({
          context: { firstPrompt: 'Explain migrations' },
          params: { agentId: 'codex', model: 'selected-model' },
          target: { kind: 'local', cwd: '/owned', env: { CODEX_HOME: `/isolated/${route}` } },
          spawnAgent: withPolicyProbes(() => child),
          shouldExecute: () => true
        }).then((result) => {
          settled = true
          return result
        })
        await vi.advanceTimersByTimeAsync(0)
        if (route === 'exit-first') {
          child.emit('exit', 0)
        }
        if (route === 'cancel') {
          cancelLocalGeneration('conversation-name', '/owned')
        } else if (route === 'error') {
          child.emit('error', new Error('Live failure'))
        } else if (route === 'overflow') {
          child.stdout.emit('data', Buffer.alloc(MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES + 1))
        } else if (route !== 'stdin') {
          await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
        }
        expect(settled).toBe(false)
        expect(stopping).toHaveBeenCalledOnce()
        Object.defineProperty(child, 'signalCode', { value: 'SIGTERM' })
        child.emit('exit', null, 'SIGTERM')
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)
        cleanup.resolve()
        await vi.advanceTimersByTimeAsync(0)
        if (route === 'overflow') {
          // Overflow's existing result policy is classified only at close.
          expect(settled).toBe(false)
          child.emit('close', 1)
        }
        await expect(request).resolves.toMatchObject({ success: false })
        child.emit('error', new Error('Late error'))
        expect(stopping).toHaveBeenCalledOnce()
        expect(child.kill.mock.calls).toEqual([['SIGTERM']])
      } finally {
        cleanup.resolve()
        stopping.mockRestore()
        errors.mockRestore()
      }
    }
  )

  it.each(['claude', 'custom'] as const)(
    'preserves applicable %s plans and skips stale fallback',
    async (agentId) => {
      for (const currentAfterClose of [true, false]) {
        const first = createMockDiscoveryChild()
        const second = createMockDiscoveryChild()
        const spawnAgent = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
        let current = true
        const request = generateConversationName({
          context: { firstPrompt: 'Explain migrations' },
          params: {
            agentId,
            model: 'selected-model',
            thinkingLevel: 'high',
            commandInputTemplate: '{firstPrompt}',
            customAgentCommand: 'chosen-agent --model selected-model',
            agentCommandOverride: agentId === 'custom' ? undefined : `${agentId} --user-option`
          },
          target: { kind: 'local', cwd: '/configured', env: { NAMING_FIXTURE: 'selected-env' } },
          spawnAgent,
          shouldExecute: () => current
        })
        expect(spawnAgent).toHaveBeenCalledOnce()
        expect(spawnAgent.mock.calls[0]![0]).toMatchObject({
          cwd: '/configured',
          env: { NAMING_FIXTURE: 'selected-env' }
        })
        first.stderr.emit(
          'data',
          Buffer.from(
            agentId === 'claude'
              ? 'You cannot use --strict-mcp-config when an enterprise MCP config is present'
              : 'Command failed'
          )
        )
        first.emit('exit', 1)
        await Promise.resolve()
        expect(spawnAgent).toHaveBeenCalledOnce()
        current = currentAfterClose
        first.emit('close', 1)
        if (currentAfterClose && agentId !== 'custom') {
          await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalledTimes(2))
          const before = spawnAgent.mock.calls[0]![0]
          const after = spawnAgent.mock.calls[1]![0]
          expect(after).toMatchObject({ binary: before.binary, cwd: before.cwd, env: before.env })
          expect(before.args).toContain('--strict-mcp-config')
          expect(after.args).not.toContain('--strict-mcp-config')
          expect(after.args).toContain('selected-model')
          expect(second.stdin.end).toHaveBeenCalledWith(
            'Explain migrations\n\nThis is a naming-only task. Do not edit files, run commands, use tools, or perform the first request.'
          )
          second.stdout.emit('data', Buffer.from('Migration guide'))
          second.emit('close', 0)
          await expect(request).resolves.toMatchObject({ success: true, name: 'Migration guide' })
        } else {
          await expect(request).resolves.toMatchObject({ success: false })
          expect(spawnAgent).toHaveBeenCalledOnce()
        }
        expect(first.kill).not.toHaveBeenCalled()
      }
    }
  )

  it('settles safe no-process failures and never kills a classified closed supervisor', async () => {
    for (const route of ['throw', 'no-pid', 'classified']) {
      const child = Object.assign(createMockDiscoveryChild(), { supervised: true as const })
      if (route === 'no-pid') {
        Object.defineProperty(child, 'pid', { value: undefined })
      }
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const request = generateConversationName({
          context: { firstPrompt: 'Explain migrations' },
          params: { agentId: 'custom', model: '', customAgentCommand: 'chosen-agent' },
          target: { kind: 'local', cwd: '/failed' },
          spawnAgent: () => {
            if (route === 'throw') {
              throw new Error('Spawn failed')
            }
            return child
          },
          shouldExecute: () => true
        })
        if (route === 'no-pid') {
          child.emit('error', Object.assign(new Error('Missing'), { code: 'ENOENT' }))
        }
        if (route === 'classified') {
          child.stderr.emit(
            'data',
            Buffer.from(
              `[orca-provider-supervisor] spawn failed: ${JSON.stringify({ thrown: false, code: 'ENOENT', message: 'Missing' })}`
            )
          )
          child.emit('close', 127)
        }
        await expect(request).resolves.toMatchObject({ success: false })
        expect(child.kill).not.toHaveBeenCalled()
      } finally {
        errors.mockRestore()
      }
    }
  })
})

describe('a supervised Codex model discovery that runs out of time', () => {
  it('times out at once but holds the Codex home until the supervisor has stopped', async () => {
    vi.useFakeTimers()
    const stopMs = 2_000
    const agents = [fakeSupervisedAgent(stopMs), fakeSupervisedAgent(stopMs)]
    const spawnAgent = vi.fn(() => asSpawned(agents[spawnAgent.mock.calls.length - 1]!))
    const discover = (): ReturnType<typeof discoverModelsLocal> =>
      discoverModelsLocal({
        agentId: 'codex',
        env: { CODEX_HOME: '/codex/discovery-timeout-home' },
        options: {},
        backslash: 'escape',
        spawnAgent
      })

    const first = discover()
    await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    await expect(first).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/timed out/)
    })
    expect(agents[0]!.kill.mock.calls).toEqual([['SIGTERM']])

    const second = discover()
    await vi.advanceTimersByTimeAsync(stopMs - 1)
    expect(spawnAgent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnAgent).toHaveBeenCalledTimes(2)

    agents[1]!.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] }))
    )
    agents[1]!.emit('close', 0)
    await expect(second).resolves.toMatchObject({ success: true })
    expect(agents[0]!.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(terminateTreeMock).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform !== 'win32')(
  'killSourceControlAgentProcess on a real agent',
  () => {
    it('holds the Codex home until a canceled agent has stopped through its supervisor', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-supervised-cancel-'))
      const pids: number[] = []
      try {
        const home = join(folder, 'codex-home')
        for (const repo of ['first', 'second']) {
          mkdirSync(join(folder, repo))
        }
        const pidFile = join(folder, 'first-pid')
        const stoppedFile = join(folder, 'first-stopped')
        // Model a CLI that ignores stdin EOF and flushes state before stopping on SIGTERM.
        const slowStop = join(folder, 'slow-stop.cjs')
        writeFileSync(
          slowStop,
          `if (process.argv.includes('mcp')) { console.log('[]'); process.exit(0) }
process.stdin.resume()
process.on('SIGTERM', () => setTimeout(() => {
  require('node:fs').writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
  process.exit(0)
}, 300))
setInterval(() => {}, 60000)
// Publish readiness only after the signal handler is installed.
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
`
        )
        const answers = join(folder, 'answers.cjs')
        writeFileSync(
          answers,
          "process.stdin.resume().on('end', () => console.log(process.argv.includes('mcp') ? '[]' : 'Update README'))\n"
        )
        const firstAliveAtSecondSpawn: boolean[] = []
        const spawnAgent = vi.fn((input: Parameters<typeof spawnSourceControlAgent>[0]) => {
          if (pids.length > 0 && !input.args.includes('mcp')) {
            firstAliveAtSecondSpawn.push(isAlive(pids[0]!))
          }
          return spawnSourceControlAgent(input)
        })
        const request = (cwd: string, script: string): ReturnType<typeof generateCommitMessage> =>
          generateCommitMessage({
            context: { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
            params: {
              agentId: 'codex',
              model: 'gpt-5.5',
              agentCommandOverride: `CODEX_HOME="${home}" "${process.execPath}" "${script}"`
            },
            target: { kind: 'local', cwd, env: process.env },
            spawnAgent
          })

        const first = request(join(folder, 'first'), slowStop)
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
        pids.push(Number(readFileSync(pidFile, 'utf8')))
        cancelGenerateCommitMessageLocal(join(folder, 'first'))
        await expect(first).resolves.toMatchObject({ canceled: true })

        await expect(request(join(folder, 'second'), answers)).resolves.toMatchObject({
          success: true,
          message: 'Update README'
        })
        expect(firstAliveAtSecondSpawn).toEqual([false])
        expect(readFileSync(stoppedFile, 'utf8')).toBe('stopped')
        expect(terminateTreeMock).not.toHaveBeenCalled()
      } finally {
        for (const pid of pids) {
          if (isAlive(pid)) {
            process.kill(pid, 'SIGKILL')
          }
        }
        rmSync(folder, { recursive: true, force: true })
      }
    })

    it('stops an agent through its supervisor once its output passes the limit', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-supervised-output-limit-'))
      const pids: number[] = []
      try {
        const pidFile = join(folder, 'agent-pid')
        const agent = join(folder, 'floods.cjs')
        writeFileSync(
          agent,
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdin.resume()
process.stdout.write('x'.repeat(5 * 1024 * 1024))
setInterval(() => {}, 60000)
`
        )

        await expect(
          generateCommitMessage({
            context: { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
            params: {
              agentId: 'custom',
              model: '',
              customAgentCommand: `"${process.execPath}" "${agent}"`
            },
            target: { kind: 'local', cwd: folder, env: process.env },
            spawnAgent: spawnSourceControlAgent
          })
        ).resolves.toMatchObject({
          success: false,
          error: expect.stringMatching(/too much output/)
        })
        pids.push(Number(readFileSync(pidFile, 'utf8')))
        expect(isAlive(pids[0]!)).toBe(false)
        expect(terminateTreeMock).not.toHaveBeenCalled()
      } finally {
        for (const pid of pids) {
          if (isAlive(pid)) {
            process.kill(pid, 'SIGKILL')
          }
        }
        rmSync(folder, { recursive: true, force: true })
      }
    })

    it('stops a Codex discovery through its supervisor once its output passes the limit, holding the home', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-supervised-discovery-limit-'))
      const pids: number[] = []
      try {
        const home = join(folder, 'codex-home')
        const pidFile = join(folder, 'flood-pid')
        const floods = join(folder, 'floods.cjs')
        writeFileSync(
          floods,
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300))
process.stdout.write('x'.repeat(5 * 1024 * 1024))
setInterval(() => {}, 60000)
`
        )
        const lists = join(folder, 'lists.cjs')
        writeFileSync(
          lists,
          "console.log(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] }))\n"
        )
        const floodAliveAtSecondSpawn: boolean[] = []
        const spawnAgent = vi.fn((input: Parameters<typeof spawnSourceControlAgent>[0]) => {
          if (pids.length > 0 && !input.args.includes('mcp')) {
            floodAliveAtSecondSpawn.push(isAlive(pids[0]!))
          }
          return spawnSourceControlAgent(input)
        })
        const discover = (script: string): ReturnType<typeof discoverModelsLocal> =>
          discoverModelsLocal({
            agentId: 'codex',
            env: process.env,
            agentCommandOverride: `CODEX_HOME="${home}" "${process.execPath}" "${script}"`,
            options: { cwd: folder },
            backslash: 'escape',
            spawnAgent
          })

        await expect(discover(floods)).resolves.toEqual({
          success: false,
          error: 'Codex returned too much model data.'
        })
        pids.push(Number(readFileSync(pidFile, 'utf8')))

        await expect(discover(lists)).resolves.toMatchObject({ success: true })
        expect(floodAliveAtSecondSpawn).toEqual([false])
        expect(terminateTreeMock).not.toHaveBeenCalled()
      } finally {
        for (const pid of pids) {
          if (isAlive(pid)) {
            process.kill(pid, 'SIGKILL')
          }
        }
        rmSync(folder, { recursive: true, force: true })
      }
    })
  }
)
