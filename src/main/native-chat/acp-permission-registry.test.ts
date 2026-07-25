import { describe, expect, it } from 'vitest'
import { createAcpPermissionRegistry, type AcpPermissionPrompt } from './acp-permission-registry'

const PARAMS = {
  toolCall: { title: 'Run shell command', rawInput: { command: 'rm -rf build' } },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'rej', name: 'Reject', kind: 'reject_once' }
  ]
}

function setup() {
  const prompts: { senderId: number; prompt: AcpPermissionPrompt }[] = []
  const registry = createAcpPermissionRegistry((senderId, prompt) =>
    prompts.push({ senderId, prompt })
  )
  return { registry, prompts }
}

describe('createAcpPermissionRegistry', () => {
  it('emits an approval prompt built from the tool call', async () => {
    const { registry, prompts } = setup()
    const pending = registry.request({ senderId: 1, subscriptionId: 'sub', params: PARAMS })

    expect(prompts).toHaveLength(1)
    expect(prompts[0].senderId).toBe(1)
    expect(prompts[0].prompt.title).toBe('Run shell command')
    expect(prompts[0].prompt.detail).toBe('rm -rf build')
    // Affirmative option first, carrying the ACP optionId.
    expect(prompts[0].prompt.options[0]).toEqual({ label: 'Allow once', send: 'once' })

    registry.respond(prompts[0].prompt.requestId, 'once')
    await expect(pending).resolves.toBe('once')
  })

  it('resolves the operator choice back to the blocked agent request', async () => {
    const { registry, prompts } = setup()
    const pending = registry.request({ senderId: 1, subscriptionId: 'sub', params: PARAMS })
    registry.respond(prompts[0].prompt.requestId, 'rej')
    await expect(pending).resolves.toBe('rej')
    expect(registry.pendingCount).toBe(0)
  })

  it('treats a null answer as a cancel', async () => {
    const { registry, prompts } = setup()
    const pending = registry.request({ senderId: 1, subscriptionId: 'sub', params: PARAMS })
    registry.respond(prompts[0].prompt.requestId, null)
    await expect(pending).resolves.toBeNull()
  })

  it('cancels immediately when the request has nothing answerable', async () => {
    const { registry, prompts } = setup()
    await expect(
      registry.request({ senderId: 1, subscriptionId: 'sub', params: { options: [] } })
    ).resolves.toBeNull()
    // No card can be built, so nothing is shown to the operator.
    expect(prompts).toHaveLength(0)
  })

  it('correlates concurrent requests independently', async () => {
    const { registry, prompts } = setup()
    const first = registry.request({ senderId: 1, subscriptionId: 'a', params: PARAMS })
    const second = registry.request({ senderId: 1, subscriptionId: 'b', params: PARAMS })
    expect(registry.pendingCount).toBe(2)

    registry.respond(prompts[1].prompt.requestId, 'once')
    await expect(second).resolves.toBe('once')
    expect(registry.pendingCount).toBe(1)

    registry.respond(prompts[0].prompt.requestId, 'rej')
    await expect(first).resolves.toBe('rej')
  })

  it('ignores an unknown or duplicate response', async () => {
    const { registry, prompts } = setup()
    const pending = registry.request({ senderId: 1, subscriptionId: 'sub', params: PARAMS })
    expect(registry.respond('nope', 'once')).toBe(false)
    expect(registry.respond(prompts[0].prompt.requestId, 'once')).toBe(true)
    // A second click must not throw or double-answer the agent.
    expect(registry.respond(prompts[0].prompt.requestId, 'rej')).toBe(false)
    await expect(pending).resolves.toBe('once')
  })

  it('cancels a subscription’s requests when its chat view closes', async () => {
    const { registry } = setup()
    const kept = registry.request({ senderId: 1, subscriptionId: 'keep', params: PARAMS })
    const closed = registry.request({ senderId: 1, subscriptionId: 'close', params: PARAMS })

    expect(registry.cancelSubscription(1, 'close')).toBe(1)
    await expect(closed).resolves.toBeNull()
    expect(registry.pendingCount).toBe(1)

    registry.cancelSubscription(1, 'keep')
    await expect(kept).resolves.toBeNull()
  })

  it('cancels every request owned by a destroyed renderer', async () => {
    const { registry } = setup()
    const mine = registry.request({ senderId: 1, subscriptionId: 'a', params: PARAMS })
    const other = registry.request({ senderId: 2, subscriptionId: 'b', params: PARAMS })

    expect(registry.cancelSender(1)).toBe(1)
    await expect(mine).resolves.toBeNull()
    // A different window's request is untouched.
    expect(registry.pendingCount).toBe(1)
    registry.cancelSender(2)
    await expect(other).resolves.toBeNull()
  })

  it('cancels when the renderer cannot be reached — never blocks the agent', async () => {
    const registry = createAcpPermissionRegistry(() => {
      throw new Error('webContents destroyed')
    })
    await expect(
      registry.request({ senderId: 1, subscriptionId: 'sub', params: PARAMS })
    ).resolves.toBeNull()
    expect(registry.pendingCount).toBe(0)
  })

  it('mints a unique request id per prompt', () => {
    const { registry, prompts } = setup()
    registry.request({ senderId: 1, subscriptionId: 'a', params: PARAMS })
    registry.request({ senderId: 1, subscriptionId: 'a', params: PARAMS })
    expect(prompts[0].prompt.requestId).not.toBe(prompts[1].prompt.requestId)
  })
})
