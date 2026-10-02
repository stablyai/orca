import { describe, expect, it } from 'vitest'
import { parseAgentStateRuleFiles } from './agent-state-rules-catalog'
import { compileTextAnchors, findPromptAnchorIndexes } from './agent-state-text-anchors'
import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE } from './blocked-text-layer'
import { detectTerminalWaitBlockedReason } from '../terminal-wait-detection'

function anchorsOf(anchors: unknown[]) {
  return compileTextAnchors(
    parseAgentStateRuleFiles([{ id: 'cursor', engineVersion: 1, anchors, rules: [] }])
  )
}

describe('blocked anchors', () => {
  const [menu] = anchorsOf([
    {
      id: 'menu',
      why: 'test',
      when: {
        region: 'text',
        find: { lastOf: 'run it?' },
        withinLastLines: 4,
        lines: { atLeast: 2, includingLast: true, test: { regex: '\\([a-z]\\)$' } }
      },
      answer: { state: 'blocked', reason: 'agent-approval-prompt' }
    }
  ]).blocked

  it('reports where the anchor starts once enough choices own the bottom', () => {
    const text = 'chat\nrun it?\nyes (y)\nno (n)\n'
    expect(menu(text)).toEqual({
      answer: { state: 'blocked', reason: 'agent-approval-prompt' },
      index: text.indexOf('run it?')
    })
  })

  it('refuses a menu with too few choices, or one no longer at the bottom', () => {
    expect(menu('run it?\nyes (y)\n')).toBeNull()
    expect(menu('run it?\nyes (y)\nno (n)\nlater output')).toBeNull()
  })

  it('reads only the last lines', () => {
    expect(menu('run it?\na\nb\nyes (y)\nno (n)')).toBeNull()
  })
})

describe('prompt anchors', () => {
  const [prompt] = anchorsOf([
    {
      id: 'prompt',
      why: 'test',
      when: { region: 'text', find: { lastOf: 'banner' }, after: { contains: '→' } },
      answer: { state: 'idle' }
    }
  ]).prompts

  it('needs the after test to pass on the text after the last banner', () => {
    expect(prompt('banner\n→')).toEqual({ answer: { state: 'idle' }, index: 0 })
    expect(prompt('→ banner')).toBeNull()
  })

  it('reads a bundled busy prompt as live but not ready', () => {
    expect(findPromptAnchorIndexes('cursor agent\n⠋ generating\n→')).toEqual({
      live: 0,
      ready: null
    })
    expect(findPromptAnchorIndexes('cursor agent\n→')).toEqual({ live: 0, ready: 0 })
    expect(findPromptAnchorIndexes('cursor agent\n⠋ starting')).toEqual({ live: null, ready: null })
  })
})

describe('the bundled Cursor approval menu', () => {
  it('blocks once two choices own the bottom of the tail', () => {
    const menu =
      'cursor agent\n→ fix it\nrun this command?\n→ run (once) (y)\n  skip & tell the agent (esc or n)'
    expect(detectTerminalWaitBlockedReason(menu)).toBe('agent-approval-prompt')
    expect(detectTerminalWaitBlockedReason(menu.split('\n').slice(0, -1).join('\n'))).toBeNull()
  })
})

describe('the blocked layer prefilter', () => {
  it('includes every bundled blocked anchor', () => {
    expect(TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test('Run this command?')).toBe(true)
  })
})
