import { expect, it } from 'vitest'
import { acquired, fakeClaude } from './claude-structured-session-test-support'

it('sends an idle Claude model pick to the live child instead of keeping the previous model', async () => {
  const claude = fakeClaude({ initModel: 'claude-opus-5' })
  const adapter = await acquired(claude)
  const connection = claude.connections[0]!
  const pick = { sessionId: 'session-1', fence: 7, key: 'model', value: 'claude-haiku' }
  try {
    expect(adapter.canSetOptionWhileIdle?.(pick)).toBe(true)
    expect(adapter.canSetOptionWhileIdle?.({ ...pick, key: 'effort', value: 'low' })).toBe(false)
    expect(adapter.canSetOptionWhileIdle?.({ ...pick, key: 'fastMode', value: 'true' })).toBe(false)
    expect(adapter.canSetOptionWhileIdle?.({ ...pick, fence: 8 })).toBe(false)
    expect(adapter.canSetOptionWhileIdle?.({ ...pick, sessionId: 'missing' })).toBe(false)
    connection.exitVerdict = { ...connection.exitVerdict, root: 'exited' }
    expect(adapter.canSetOptionWhileIdle?.(pick)).toBe(false)
    connection.exitVerdict = { ...connection.exitVerdict, root: 'live' }
    await adapter.setOption(pick)
    expect(connection.calls).toContainEqual({
      subtype: 'set_model',
      params: { model: 'claude-haiku' }
    })
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.model).toBe(
      'claude-haiku'
    )
  } finally {
    await adapter.closeAll()
  }
})
