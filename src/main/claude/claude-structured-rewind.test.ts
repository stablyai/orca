import { describe, expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import { ClaudeRewindAttempt } from './claude-structured-rewind'
import { AgentSessionRewindRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const intent = { targetUuid: 'kept', previousLeafUuid: 'tip', dropsTurn: 'drop' }
const proofLaunch = {
  providerSessionId: PROVIDER_SESSION_ID,
  claudeConfigDir: '/claude',
  options: {},
  resumed: true,
  resumeLeafUuid: 'tip',
  cwd: '/workspace',
  pathToClaudeCodeExecutable: 'claude'
}

describe('Claude rewind acquisition', () => {
  it('executes a cursor resume in place and proves the exact target before publication', async () => {
    const fake = fakeClaude()
    const proof = vi.fn(async (_input: { intentionalRewindUuid?: string }) => 'kept')
    const adapter = adapterFor(
      fake,
      { resumed: true, resumeLeafUuid: 'tip' },
      [],
      [],
      undefined,
      proof
    )
    try {
      const acquired = await adapter.acquire({
        identity: identityFor(),
        fence: 7,
        spawnToken: 'spawn',
        rewind: intent
      })
      expect(acquired.link.handle).toMatchObject({
        provider: 'claude',
        sessionId: PROVIDER_SESSION_ID,
        leafUuid: 'kept'
      })
      expect(fake.connections[0]!.launch.options).toMatchObject({
        resume: PROVIDER_SESSION_ID,
        resumeSessionAt: 'kept',
        resumeDropsTurn: 'drop'
      })
      expect(fake.connections[0]!.launch.options).not.toHaveProperty('forkSession')
      expect(proof).toHaveBeenCalledWith(
        expect.objectContaining({ previousLeafUuid: 'tip', intentionalRewindUuid: 'kept' })
      )
      await adapter.closeSession('session-1')
      await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-next' })
      expect(fake.connections[1]!.launch.options).not.toHaveProperty('resumeDropsTurn')
      expect(
        proof.mock.calls.filter(([input]) => input.intentionalRewindUuid !== undefined)
      ).toHaveLength(1)
    } finally {
      await adapter.closeAll()
    }
  })
  it('recognizes the documented refusal and closes the failed child without retry', async () => {
    const fake = fakeClaude()
    const openConnection = fake.openConnection
    fake.openConnection = async (launch, handlers) => {
      const connection = await openConnection(launch, handlers)
      const initialize = connection.initializationResult
      connection.initializationResult = async (...args) => {
        const result = await initialize(...args)
        handlers?.onMessage?.({
          type: 'result',
          subtype: 'error_during_execution',
          session_id: PROVIDER_SESSION_ID,
          errors: ['Resume rejected by --resume-drops-turn: additional prompt observed']
        })
        return result
      }
      return connection
    }
    const proof = vi.fn(async (_input: { intentionalRewindUuid?: string }) => 'kept')
    const adapter = adapterFor(fake, { resumed: true }, [], [], undefined, proof)
    await expect(
      adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn', rewind: intent })
    ).rejects.toMatchObject({ rewindReason: 'provider-refused' })
    expect(fake.connections).toHaveLength(1)
    expect(fake.connections[0]?.closed).toBe(true)
    expect(proof).not.toHaveBeenCalled()
    await adapter.closeAll()
  })
  it('consumes proof authorization even if its first read fails', async () => {
    const proof = vi.fn(async () => {
      throw new Error('torn transcript')
    })
    const attempt = new ClaudeRewindAttempt(intent)
    const launch = {
      providerSessionId: PROVIDER_SESSION_ID,
      claudeConfigDir: '/claude',
      options: {},
      resumed: true,
      resumeLeafUuid: 'tip',
      cwd: '/workspace',
      pathToClaudeCodeExecutable: 'claude'
    }
    await expect(attempt.prove(launch, { readTranscriptLeaf: proof })).rejects.toBeInstanceOf(
      AgentSessionRewindRefusal
    )
    expect(await attempt.prove(launch, { readTranscriptLeaf: proof })).toBeNull()
    expect(proof).toHaveBeenCalledTimes(1)
  })
  it('never persists success for a mismatching leaf', async () => {
    const onProved = vi.fn(async () => {})
    const attempt = new ClaudeRewindAttempt(intent, onProved)
    await expect(
      attempt.prove(proofLaunch, { readTranscriptLeaf: async () => 'other' })
    ).rejects.toMatchObject({ rewindReason: 'proof-mismatch' })
    expect(onProved).not.toHaveBeenCalled()
  })
  it('preserves commit failure as unknown and consumes the override before persisting', async () => {
    const diskError = new Error('record write failed')
    const onProved = vi.fn(async () => {
      throw diskError
    })
    const proof = vi.fn(async () => 'kept')
    const attempt = new ClaudeRewindAttempt(intent, onProved)
    const launch = {
      providerSessionId: PROVIDER_SESSION_ID,
      claudeConfigDir: '/claude',
      options: {},
      resumed: true,
      resumeLeafUuid: 'tip',
      cwd: '/workspace',
      pathToClaudeCodeExecutable: 'claude'
    }
    await expect(attempt.prove(launch, { readTranscriptLeaf: proof })).rejects.toBe(diskError)
    expect(onProved).toHaveBeenCalledWith('kept')
    expect(await attempt.prove(launch, { readTranscriptLeaf: proof })).toBeNull()
    expect(proof).toHaveBeenCalledTimes(1)
  })
  it('checkpoints the proved target before late acquisition failure without persisting a stale cursor', async () => {
    const fake = fakeClaude()
    const launch = { resumed: true, resumeLeafUuid: 'tip' }
    const persisted: unknown[] = []
    const proof = vi.fn(async () => 'kept')
    const adapter = adapterFor(fake, launch, [], persisted, undefined, proof)
    const onProved = vi.fn(async (leafUuid: string) => {
      launch.resumeLeafUuid = leafUuid
      fake.connections[0]!.closed = true
    })
    try {
      await expect(
        adapter.acquire({
          identity: identityFor(),
          fence: 7,
          spawnToken: 'spawn',
          rewind: { ...intent, onProved }
        })
      ).rejects.toThrow('exited while being acquired')
      expect(onProved).toHaveBeenCalledWith('kept')
      expect(persisted).toEqual([])
      const acquired = await adapter.acquire({
        identity: identityFor(),
        fence: 8,
        spawnToken: 'retry'
      })
      expect(acquired.link.handle).toMatchObject({ leafUuid: 'kept' })
      expect(fake.connections[1]!.launch.options).not.toHaveProperty('resumeDropsTurn')
      expect(proof).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.closeAll()
    }
  })
  it('restores an interrupted unproved rewind only after exact ordinary branch proof', async () => {
    const fake = fakeClaude()
    const proof = vi.fn(async (_input: { intentionalRewindUuid?: string }) => 'kept')
    const restored = vi.fn(async () => {})
    const adapter = adapterFor(
      fake,
      { resumed: true, resumeLeafUuid: 'tip' },
      [],
      [],
      undefined,
      proof
    )
    const input = {
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn',
      rewindRecovery: { leafUuid: 'tip', onProved: restored }
    }
    try {
      await expect(adapter.acquire(input)).rejects.toMatchObject({ rewindReason: 'proof-mismatch' })
      expect(restored).not.toHaveBeenCalled()
      proof.mockResolvedValue('tip')
      await adapter.acquire({ ...input, fence: 8, spawnToken: 'retry' })
      expect(restored).toHaveBeenCalledOnce()
      expect(proof).toHaveBeenCalledWith(expect.objectContaining({ previousLeafUuid: 'tip' }))
      for (const [request] of proof.mock.calls) {
        expect(request).not.toHaveProperty('intentionalRewindUuid')
      }
    } finally {
      await adapter.closeAll()
    }
  })
})
