import { existsSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlAgentSpawnInput } from './source-control-text-generation-types'

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('./commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepare
}))

import { spawnSourceControlAgent } from './source-control-agent-launch'
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
