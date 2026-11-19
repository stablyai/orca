import { existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlAgentSpawnInput } from './source-control-text-generation-types'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  mkdtemp: vi.fn(),
  realMkdtemp: undefined as undefined | ((prefix: string) => Promise<string>)
}))
vi.mock('./execution/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepare
}))
// The folder step is wrapped so a test can stop the request while it is still being made.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  mocks.realMkdtemp = actual.mkdtemp
  mocks.mkdtemp.mockImplementation((prefix: string) => actual.mkdtemp(prefix))
  return { ...actual, mkdtemp: mocks.mkdtemp }
})

import { spawnSourceControlAgent } from './execution/source-control-agent-launch'
import { generateAgentText } from './agent-text-generation-request'

const host = { getAgentEnvironment: () => undefined }

function fakeAgent(script: string): {
  spawnAgent: typeof spawnSourceControlAgent
  calls: SourceControlAgentSpawnInput[]
} {
  const calls: SourceControlAgentSpawnInput[] = []
  return {
    calls,
    spawnAgent: (input) => {
      calls.push(input)
      return spawnSourceControlAgent({ ...input, binary: process.execPath, args: ['-e', script] })
    }
  }
}

const ANSWER =
  "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('Hello there\\n'))"
const HANG = 'setInterval(()=>{},1000)'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepare.mockResolvedValue({
    ok: true,
    env: { ...process.env, ORCA_TEST_ACCOUNT: 'selected' }
  })
})

describe('generateAgentText', () => {
  it('runs Claude once without tools, with the selected account, in a folder it removes', async () => {
    const agent = fakeAgent(ANSWER)
    const result = await generateAgentText(
      host,
      { agent: 'claude', model: 'haiku', prompt: 'Say hi' },
      undefined,
      agent.spawnAgent
    )

    expect(result).toMatchObject({
      success: true,
      text: 'Hello there',
      agent: 'claude',
      model: 'haiku'
    })
    const [call] = agent.calls
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku']))
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('')
    expect(call.env?.ORCA_TEST_ACCOUNT).toBe('selected')
    expect(call.cwd).toContain('orca-text-generate-')
    expect(existsSync(call.cwd ?? '')).toBe(false)
  })

  it('refuses an agent Orca cannot generate text with, before preparing an account', async () => {
    const result = await generateAgentText(host, { agent: 'not-an-agent', prompt: 'Hi' })

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('claude') })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('does not start the agent when the stop comes while the folder is being made', async () => {
    const controller = new AbortController()
    mocks.mkdtemp.mockImplementationOnce(async (prefix: string) => {
      controller.abort()
      return mocks.realMkdtemp!(prefix)
    })
    const agent = fakeAgent(ANSWER)
    const result = await generateAgentText(
      host,
      { agent: 'claude', model: 'haiku', prompt: 'Hi' },
      controller.signal,
      agent.spawnAgent
    )

    expect(result).toEqual({ success: false, error: 'Text generation canceled.', canceled: true })
    expect(agent.calls).toHaveLength(0)
  })

  it('reports no model after Copilot falls back to its default model', async () => {
    const calls: SourceControlAgentSpawnInput[] = []
    const spawnAgent: typeof spawnSourceControlAgent = (input) => {
      calls.push(input)
      const rejected = input.args.includes('--model')
      const script = rejected
        ? 'process.stderr.write(\'Error: Model "gpt-5.4" from --model flag is not available.\\n\');process.exit(1)'
        : ANSWER
      return spawnSourceControlAgent({ ...input, binary: process.execPath, args: ['-e', script] })
    }
    const result = await generateAgentText(
      host,
      { agent: 'copilot', model: 'gpt-5.4', prompt: 'Say hi' },
      undefined,
      spawnAgent
    )

    expect(result).toMatchObject({
      success: true,
      text: 'Hello there',
      agent: 'copilot',
      model: null
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].args).not.toContain('--model')
  })

  it('stops the agent and removes its folder when the timeout passes', async () => {
    const agent = fakeAgent(HANG)
    const result = await generateAgentText(
      host,
      { agent: 'claude', model: 'haiku', prompt: 'Hi', timeoutMs: 300 },
      undefined,
      agent.spawnAgent
    )

    expect(result).toEqual({ success: false, error: 'Text generation timed out.', timedOut: true })
    expect(existsSync(agent.calls[0].cwd ?? '')).toBe(false)
  })
})
