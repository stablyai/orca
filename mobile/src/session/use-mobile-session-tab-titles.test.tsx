import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionTabTitles } from './use-mobile-session-tab-titles'
import type { MobileDesktopTabTitle } from './mobile-desktop-tab-titles'

function terminal(
  title: string,
  launchAgent?: TuiAgent,
  handle = 'pty-1',
  id = 'tab-1'
): Extract<MobileSessionTab, { type: 'terminal' }> {
  return { type: 'terminal', id, title, terminal: handle, isActive: true, launchAgent }
}

describe('Cursor tab display names on mobile', () => {
  let renderer: ReactTestRenderer | null = null
  let titles: ReadonlyMap<string, string> = new Map()
  function Harness({
    tabs,
    scope,
    desktop
  }: {
    tabs: MobileSessionTab[]
    scope: string
    desktop?: ReadonlyMap<string, MobileDesktopTabTitle>
  }) {
    titles = useMobileSessionTabTitles(tabs, scope, desktop)
    return createElement('label', null, [...titles.values()].join('|'))
  }
  function render(
    tabs: MobileSessionTab[],
    scope = 'host-1/workspace-1',
    desktop?: ReadonlyMap<string, MobileDesktopTabTitle>
  ) {
    act(() => {
      const element = createElement(Harness, { tabs, scope, desktop })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
    return titles.get('tab-1')
  }
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const desktopTitle = (title: string | null) =>
    new Map([['pty-1', { title, tabId: 'tab-1', leafId: 'leaf-1', agentIdentity: 'cursor' }]])

  it('uses the saved desktop task name on first open and after a remount', () => {
    const tabs = [terminal('⠋ Cursor Agent')]
    const saved = desktopTitle('Saved task name')
    expect(render(tabs, undefined, saved)).toBe('Saved task name')
    act(() => renderer?.unmount())
    renderer = null
    expect(render(tabs, undefined, saved)).toBe('Saved task name')
  })

  it('prefers the saved name over OSC task titles and follows a rename at once', () => {
    const saved = desktopTitle('Saved name')
    for (const raw of ['⠹ Cursor Agent', 'Other OSC task - ⏳ Working ...', 'Cursor ready']) {
      expect(render([terminal(raw)], undefined, saved)).toBe('Saved name')
    }
    expect(render([terminal('Cursor ready')], undefined, desktopTitle('Renamed'))).toBe('Renamed')
  })

  it('falls back to the current title, not the old saved name, once the saved name is cleared', () => {
    render([terminal('Cursor Agent')], undefined, desktopTitle('Saved name'))
    expect(render([terminal('Cursor Agent')], undefined, desktopTitle(null))).toBe('Cursor Agent')
    expect(
      render([terminal('Current task - ⏳ Working ...', 'cursor')], undefined, desktopTitle(null))
    ).toBe('Current task')
  })

  it('does not pin a generic Cursor status title as the saved task name', () => {
    expect(
      render(
        [terminal('Current task - ⏳ Working ...', 'cursor')],
        undefined,
        desktopTitle('Cursor ready')
      )
    ).toBe('Current task')
    expect(render([terminal('⠋ Cursor Agent')], undefined, desktopTitle('Cursor Agent'))).toBe(
      'Current task'
    )
  })

  it('ignores a saved name for the same handle under another parent tab or leaf', () => {
    const saved = desktopTitle('Other tab name')
    expect(
      render([{ ...terminal('Cursor Agent'), parentTabId: 'other-tab' }], undefined, saved)
    ).toBe('Cursor Agent')
    expect(
      render([{ ...terminal('Cursor Agent'), leafId: 'replacement-leaf' }], undefined, saved)
    ).toBe('Cursor Agent')
  })

  it('does not apply a Cursor saved name when another agent owns the tab', () => {
    expect(
      render([terminal('New Claude task', 'claude')], undefined, desktopTitle('Old Cursor name'))
    ).toBe('New Claude task')
  })

  it('keeps the name through the generic and task title frames Cursor alternates', () => {
    expect(render([terminal('Fix tab titles - ⏳ Working ...', 'cursor')])).toBe('Fix tab titles')
    for (let i = 0; i < 120; i++) {
      const frame = [
        '⠋ Cursor Agent',
        'Fix tab titles - ⏳ Working ..·',
        '⠹ Cursor Agent',
        'Fix tab titles - ⏳ Working ···',
        'Cursor ready',
        'Cursor - action required'
      ][i % 6]
      expect(render([terminal(frame, 'cursor')])).toBe('Fix tab titles')
    }
  })

  it('identifies a hookless tab as Cursor from its generic title, then keeps the task name', () => {
    expect(render([terminal('⠋ Cursor Agent')])).toBe('Cursor Agent')
    expect(render([terminal('Fix tab titles - ⏳ Working .··')])).toBe('Fix tab titles')
    expect(render([terminal('⠸ Cursor Agent')])).toBe('Fix tab titles')
  })

  it('shows a manual rename and a new task title at once', () => {
    render([terminal('Fix tab titles - ⏳ Working ...', 'cursor')])
    expect(render([terminal('Manual name', 'cursor')])).toBe('Manual name')
    expect(render([terminal('⠹ Cursor Agent', 'cursor')])).toBe('Manual name')
    expect(render([terminal('New task - ⏳ Working ···', 'cursor')])).toBe('New task')
  })

  it('does not mix names when the same tab id exists on another host or workspace', () => {
    render([terminal('First name', 'cursor')])
    expect(render([terminal('⠋ Cursor Agent', 'cursor')], 'host-2/workspace-1')).toBe(
      'Cursor Agent'
    )
    render([terminal('Other name', 'cursor')], 'host-2/workspace-1')
    expect(render([terminal('⠋ Cursor Agent', 'cursor')], 'host-2/workspace-2')).toBe(
      'Cursor Agent'
    )
  })

  it('does not hand a name to a replaced terminal or a tab that closed and came back', () => {
    render([terminal('First name', 'cursor')])
    expect(render([terminal('⠋ Cursor Agent', 'cursor', 'pty-2')])).toBe('Cursor Agent')
    render([terminal('Second name', 'cursor', 'pty-2')])
    render([])
    expect(render([terminal('⠋ Cursor Agent', 'cursor', 'pty-2')])).toBe('Cursor Agent')
  })

  it('drops the Cursor name once the tab switches to another agent', () => {
    render([terminal('Previous name', 'cursor')])
    expect(render([terminal('✳ New task', 'claude')])).toBe('New task')
    expect(render([terminal('Codex ready')])).toBe('Codex ready')
  })

  it('passes title changes through unchanged for other agents and plain shells', () => {
    for (const agent of ['claude', 'codex', 'grok'] as const) {
      expect(render([terminal('First task', agent)])).toBe('First task')
      expect(render([terminal('Next task - ⏳ Working ...', agent)])).toBe(
        'Next task - ⏳ Working ...'
      )
    }
    expect(render([terminal('plain shell')])).toBe('plain shell')
    expect(render([terminal('another shell title')])).toBe('another shell title')
  })

  it('keeps each Cursor tab its own name', () => {
    render([terminal('First task', 'cursor'), terminal('Second task', 'cursor', 'pty-2', 'tab-2')])
    render([
      terminal('⠋ Cursor Agent', 'cursor'),
      terminal('⠹ Cursor Agent', 'cursor', 'pty-2', 'tab-2')
    ])
    expect([...titles.values()]).toEqual(['First task', 'Second task'])
  })
})
