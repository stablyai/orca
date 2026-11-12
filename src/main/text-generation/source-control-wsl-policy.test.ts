import { generationArgumentText } from '../../shared/source-control/ai/generation/generation-argument'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/source-control/ai/generation/commit-message-plan'
import { createMockDiscoveryChild } from './commit-message-text-generation-test-harness'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { runLocalPlanForAgent } from './source-control-local-generation'
import { prepareSourceControlReadOnlyPlan } from './source-control-read-only-policy'
import type { WslSpec } from '../wsl/execution/wsl-runner'

const { runWsl, stop, probe } = vi.hoisted(() => ({
  runWsl: vi.fn(),
  stop: vi.fn(async () => {}),
  probe: vi.fn()
}))
vi.mock('../wsl/execution/wsl-runner', () => ({ runWslProcess: runWsl }))
vi.mock('./source-control-agent-termination', () => ({ killSourceControlAgentProcess: stop }))
vi.mock('./source-control-policy-probe', () => ({ runSourceControlPolicyProbe: probe }))

const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  probe.mockReturnValue({
    result: Promise.resolve({ stdout: '  --settings Settings for this session', stderr: '' }),
    processClosed: Promise.resolve()
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.clearAllMocks()
})

function planned(agentId: 'claude' | 'kimi' | 'antigravity', agentArgs?: string) {
  const result = planCommitMessageGeneration(
    { agentId, model: 'default', agentArgs, backslash: 'literal' },
    'Write a commit message'
  )
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.plan
}

function output(stdout: string) {
  return { code: 0, stdout, stderr: '', timedOut: false, environmentResolved: true }
}

it.each(['/mnt/c', '/c'])(
  'reads a Windows Kimi recipe through the selected mount %s and preserves its instructions',
  async (mount) => {
    const reads: WslSpec[] = []
    runWsl.mockImplementation(async (spec: WslSpec) => {
      if (spec.program === 'wslpath') {
        return output(
          spec.args?.at(-1) === 'C:\\repo' ? `${mount}/repo\n` : `${mount}/profiles/agent.md\n`
        )
      }
      reads.push(spec)
      if (spec.cwd !== `${mount}/repo` || spec.args?.[0] !== `${mount}/profiles/agent.md`) {
        throw new Error('Wrong recipe location')
      }
      return output('---\nname: reviewer\ntools: ["*"]\n---\nKeep these review instructions.\n')
    })
    const signal = new AbortController().signal
    const plan = await prepareSourceControlReadOnlyPlan({
      agentId: 'kimi',
      plan: planned('kimi', '--agent-file C:\\profiles\\agent.md'),
      target: { kind: 'local', cwd: 'C:\\repo', wslDistro: 'Ubuntu' },
      signal,
      spawnAgent: vi.fn()
    }).result
    expect(plan.taskFiles?.[0].content).toContain('Keep these review instructions.')
    expect(plan.taskFiles?.[0].content).toContain('tools: []')
    expect(reads[0].signal).toBe(signal)
  }
)

it('retains same-distro UNC and guest-relative recipe identities without reading another distro', async () => {
  const reads: string[] = []
  runWsl.mockImplementation(async (spec: WslSpec) => {
    if (spec.cwd !== '/home/repo') {
      throw new Error('Wrong guest workspace')
    }
    reads.push(String(spec.args?.[0]))
    return output('{"customSetting":"preserved"}')
  })
  const target = {
    kind: 'local' as const,
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
    wslDistro: 'Ubuntu'
  }
  for (const file of [
    '\\\\wsl$\\ubuntu\\home\\settings.json',
    'settings.json',
    '~/settings.json'
  ]) {
    const plan = await prepareSourceControlReadOnlyPlan({
      agentId: 'antigravity',
      plan: planned('antigravity', `--settings '${file}'`),
      target,
      signal: new AbortController().signal,
      spawnAgent: vi.fn()
    }).result
    expect(
      JSON.parse(generationArgumentText(plan.args[plan.args.indexOf('--settings') + 1]))
    ).toMatchObject({
      customSetting: 'preserved',
      permissions: { deny: expect.arrayContaining(['write_file(*)', 'command(*)', 'mcp(*)']) }
    })
  }
  await expect(
    prepareSourceControlReadOnlyPlan({
      agentId: 'antigravity',
      plan: planned('antigravity', "--settings '\\\\wsl$\\Debian\\home\\settings.json'"),
      target,
      signal: new AbortController().signal,
      spawnAgent: vi.fn()
    }).result
  ).rejects.toThrow('another WSL distro')
  expect(reads).toEqual(['/home/settings.json', 'settings.json', '~/settings.json'])
})

it('launches a non-policy agent in the resolved cwd while cancel still targets the original workspace', async () => {
  runWsl.mockResolvedValue(output('/c/repo\n'))
  const child = createMockDiscoveryChild()
  const launched = Promise.withResolvers<void>()
  const spawnAgent = vi.fn((input) => {
    expect(input.cwd).toBe('/c/repo')
    expect(input.wslDistro).toBe('Ubuntu')
    launched.resolve()
    return child
  })
  const generation = runLocalPlanForAgent({
    agentId: 'claude',
    plan: planned('claude'),
    target: { kind: 'local', cwd: 'C:\\repo', wslDistro: 'Ubuntu' },
    operation: 'commit-message',
    spawnAgent
  })
  await launched.promise
  cancelLocalGeneration('commit-message', 'C:\\repo')
  await expect(generation).resolves.toMatchObject({ canceled: true })
  expect(stop).toHaveBeenCalledWith(child)
  child.emit('close', 0)
})

it('keeps a Windows-host generation in a WSL-share workspace on the selected host', async () => {
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\repo'
  const child = createMockDiscoveryChild()
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('Keep the selected Windows host\n'))
      child.emit('close', 0)
    })
  )
  await expect(
    runLocalPlanForAgent({
      agentId: 'claude',
      plan: planned('claude'),
      target: { kind: 'local', cwd },
      operation: 'commit-message',
      spawnAgent: (input) => {
        expect(input.cwd).toBe(cwd)
        expect(input.wslDistro).toBeUndefined()
        return child
      }
    })
  ).resolves.toMatchObject({ success: true, rawOutput: 'Keep the selected Windows host' })
})

it('uses the workspace share distro when it supersedes a configured WSL hint', async () => {
  const child = createMockDiscoveryChild()
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('Use the workspace distro\n'))
      child.emit('close', 0)
    })
  )
  await expect(
    runLocalPlanForAgent({
      agentId: 'claude',
      plan: planned('claude'),
      target: {
        kind: 'local',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
        wslDistro: 'Debian'
      },
      operation: 'commit-message',
      spawnAgent: (input) => {
        expect(input.cwd).toBe('/home/repo')
        expect(input.wslDistro).toBe('Ubuntu')
        return child
      }
    })
  ).resolves.toMatchObject({ success: true, rawOutput: 'Use the workspace distro' })
})

it('uses the resolved project for Antigravity policy discovery and the resulting generation', async () => {
  runWsl.mockResolvedValue(output('/c/repo\n'))
  const child = createMockDiscoveryChild()
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          '{"event":"result","result":{"status":"SUCCESS","response":"Describe the changes"}}\n'
        )
      )
      child.emit('close', 0)
    })
  )
  await expect(
    runLocalPlanForAgent({
      agentId: 'antigravity',
      plan: planned('antigravity'),
      target: { kind: 'local', cwd: 'C:\\repo', wslDistro: 'Ubuntu' },
      operation: 'commit-message',
      spawnAgent: (input) => {
        expect(input.cwd).toBe('/c/repo')
        return child
      }
    })
  ).resolves.toMatchObject({ success: true, rawOutput: 'Describe the changes' })
  expect(probe.mock.calls[0][0].target).toMatchObject({ cwd: '/c/repo', wslDistro: 'Ubuntu' })
})

it('does not fall back to a guessed mount when native drive resolution fails', async () => {
  runWsl.mockResolvedValue({ ...output(''), code: 1 })
  const spawnAgent = vi.fn()
  await expect(
    runLocalPlanForAgent({
      agentId: 'claude',
      plan: planned('claude'),
      target: { kind: 'local', cwd: 'C:\\repo', wslDistro: 'Ubuntu' },
      operation: 'commit-message',
      spawnAgent
    })
  ).resolves.toMatchObject({ success: false })
  expect(spawnAgent).not.toHaveBeenCalled()
})

it('does not launch after cancellation during drive resolution, and a successor can complete', async () => {
  const resolving = Promise.withResolvers<WslSpec>()
  const release = Promise.withResolvers<ReturnType<typeof output>>()
  runWsl.mockImplementationOnce((spec: WslSpec) => {
    resolving.resolve(spec)
    return release.promise
  })
  const child = createMockDiscoveryChild()
  child.stdin.end.mockImplementation(() =>
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('Update source control generation\n'))
      child.emit('close', 0)
    })
  )
  const spawnAgent = vi.fn(() => child)
  const input = {
    agentId: 'claude',
    plan: planned('claude'),
    target: { kind: 'local' as const, cwd: 'C:\\repo', wslDistro: 'Ubuntu' },
    operation: 'commit-message' as const,
    spawnAgent
  }
  const first = runLocalPlanForAgent(input)
  const spec = await resolving.promise
  cancelLocalGeneration('commit-message', 'C:\\repo')
  await expect(first).resolves.toMatchObject({ canceled: true })
  expect(spec.signal?.aborted).toBe(true)
  release.resolve(output('/c/repo\n'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(spawnAgent).not.toHaveBeenCalled()
  runWsl.mockResolvedValue(output('/c/repo\n'))
  await expect(runLocalPlanForAgent(input)).resolves.toMatchObject({
    success: true,
    rawOutput: 'Update source control generation'
  })
})
