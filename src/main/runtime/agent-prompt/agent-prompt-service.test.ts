import { describe, expect, it } from 'vitest'
import type { PendingAgentPrompt } from '../../../shared/rpc-contract/agent-prompt-params'
import { AgentPromptService, type AgentPromptDirectory } from './agent-prompt-service'

const prompt: PendingAgentPrompt = {
  promptId: 'term:pty-1:0123456789abcdef0123',
  kind: 'permission',
  target: { type: 'terminal', terminal: 'term-1' },
  worktreeId: 'folder-notes',
  agent: 'claude',
  title: 'Bash',
  options: [
    { optionId: 'allow_once', label: 'Allow once', role: 'approve' },
    { optionId: 'reject_once', label: 'Reject', role: 'deny' }
  ],
  createdAt: 50
}

function directory(
  apply: AgentPromptDirectory['apply'],
  extras?: Partial<AgentPromptDirectory>
): {
  service: AgentPromptService
  listed: { current: boolean }
} {
  const listed = { current: true }
  const service = new AgentPromptService({
    list: () => (listed.current ? [prompt] : []),
    targetExists: () => true,
    apply,
    ...extras
  })
  return { service, listed }
}

const input = {
  promptId: prompt.promptId,
  optionId: 'allow_once',
  clientOperationId: 'op-1',
  callerKey: 'phone-1'
}

describe('AgentPromptService', () => {
  it('replays a success for the same operation without applying again', async () => {
    let calls = 0
    const { service } = directory(async () => {
      calls += 1
      return { ok: true }
    })
    expect(await service.respond(input)).toEqual({ ok: true })
    expect(await service.respond(input)).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it('shares one in-flight apply across two callers', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service } = directory(async () => {
      calls += 1
      await gate
      return { ok: true }
    })
    const first = service.respond(input)
    const second = service.respond(input)
    expect(calls).toBe(1)
    release?.()
    expect(await first).toEqual({ ok: true })
    expect(await second).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it('rejects the same operation id used for a different option', async () => {
    let calls = 0
    const { service } = directory(async () => {
      calls += 1
      return { ok: true }
    })
    expect(await service.respond(input)).toEqual({ ok: true })
    expect(await service.respond({ ...input, optionId: 'reject_once' })).toEqual({
      ok: false,
      reason: 'rejected'
    })
    expect(calls).toBe(1)
  })

  it('returns stale when the target remains and the prompt is gone, and caches it', async () => {
    let calls = 0
    const { service, listed } = directory(async () => {
      calls += 1
      return { ok: true }
    })
    listed.current = false
    expect(await service.respond(input)).toEqual({ ok: false, reason: 'stale' })
    expect(await service.respond(input)).toEqual({ ok: false, reason: 'stale' })
    expect(calls).toBe(0)
  })

  it('returns not_found when the session or pane was never here', async () => {
    let exists = 0
    const service = new AgentPromptService({
      list: () => [],
      targetExists: () => {
        exists += 1
        return false
      },
      apply: async () => ({ ok: true })
    })
    expect(await service.respond(input)).toEqual({ ok: false, reason: 'not_found' })
    expect(exists).toBe(1)
    expect(
      await service.respond({
        ...input,
        promptId: 'chat:short:item:1:4',
        clientOperationId: 'op-malformed'
      })
    ).toEqual({ ok: false, reason: 'not_found' })
    expect(exists).toBe(1)
  })

  it('rejects an option the prompt does not offer', async () => {
    let calls = 0
    const { service } = directory(async () => {
      calls += 1
      return { ok: true }
    })
    expect(await service.respond({ ...input, optionId: 'always' })).toEqual({
      ok: false,
      reason: 'rejected'
    })
    expect(calls).toBe(0)
  })

  it('caches an apply failure as unavailable', async () => {
    let calls = 0
    const { service } = directory(async () => {
      calls += 1
      throw new Error('disk')
    })
    expect(await service.respond(input)).toEqual({ ok: false, reason: 'unavailable' })
    expect(await service.respond(input)).toEqual({ ok: false, reason: 'unavailable' })
    expect(calls).toBe(1)
  })
})
