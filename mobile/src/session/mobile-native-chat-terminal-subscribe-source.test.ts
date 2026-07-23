import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('mobile native-chat terminal subscribe call site', () => {
  it('routes covered and visible subscriptions through the tested params builder', () => {
    const start = source.indexOf('const subscribeToTerminal = useCallback(')
    const end = source.indexOf('const toggleInFlightRef =', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const subscribeSource = source.slice(start, end)

    expect(subscribeSource).toContain(
      'nativeChatTerminalStream.buildMobileNativeChatTerminalSubscribeParams({'
    )
    expect(subscribeSource).toContain('covered,\n          viewport: viewportRef.current')
    expect(subscribeSource).not.toContain('capabilities: { terminalBinaryStream: 1')
  })
})
