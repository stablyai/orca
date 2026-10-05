import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from '../../shared/agent-title-status'
import { getSyntheticAgentTerminalTitle } from '../../shared/synthetic-agent-title'
import { resolveExplicitTerminalTitleAgentType } from '../../shared/terminal-title-agent-type'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'

describe('IBM Bob synthetic titles', () => {
  // Why: the rest-signal table counts Bob as `synthetic-title`, which only holds if the
  // classifiers recognize the titles Orca writes for it.
  it('recognizes the titles Orca writes for Bob', () => {
    const idle = getSyntheticAgentTerminalTitle('bob', 'done')
    const waiting = getSyntheticAgentTerminalTitle('bob', 'waiting')
    expect(idle).toBe('IBM Bob ready')
    expect(waiting).toBe('IBM Bob - action required')
    expect(detectExplicitIdleStatusFromTitle(idle!)).toBe('idle')
    expect(detectAgentStatusFromTitle(idle!)).toBe('idle')
    expect(detectAgentStatusFromTitle(waiting!)).toBe('permission')
    expect(resolveExplicitTerminalTitleAgentType(idle!)).toBe('bob')
    expect(resolveExplicitTerminalTitleAgentType(waiting!)).toBe('bob')
  })

  // Why: bare `bob` is a person's name and the Neovim version manager's binary.
  it.each(['Bob ready', 'bob@devbox: ~/src', 'bob 4.0.0', 'nvim via bob', 'bobshell'])(
    'does not treat %s as IBM Bob',
    (title) => {
      expect(resolveExplicitTerminalTitleAgentType(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )
})
