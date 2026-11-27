import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getManagedEventHook, getPosixManagedEventHook } from './claude-managed-event-hook'
import { CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS } from './claude-hook-decision-script'

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('Claude PreToolUse hook timeout', () => {
  beforeEach(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
  afterEach(() => hostPlatform && Object.defineProperty(process, 'platform', hostPlatform))

  // Claude refuses the tool call when the entry times out, so it must outlast the script's wait for Orca.
  it('leaves at least 10 s past the POSIX script wait for Orca to answer', () => {
    const scriptPath = '/home/u/.orca/agent-hooks/claude-hook.sh'

    expect(getManagedEventHook('PreToolUse', scriptPath).timeout).toBeGreaterThanOrEqual(
      CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS + 10
    )
    expect(getPosixManagedEventHook('PreToolUse', scriptPath).timeout).toBeGreaterThanOrEqual(
      CLAUDE_PRE_TOOL_USE_ANSWER_WAIT_SECONDS + 10
    )
  })
})
