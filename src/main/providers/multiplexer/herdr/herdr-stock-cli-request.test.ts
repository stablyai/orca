import { describe, expect, it } from 'vitest'
import { herdrStockCliInvocation } from './herdr-cli-session'

describe('stock Herdr CLI request adapter', () => {
  it('uses public snapshot and metadata commands', () => {
    expect(herdrStockCliInvocation('orca-app', 'session.snapshot', {}).args).toEqual([
      '--session',
      'orca-app',
      'api',
      'snapshot'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.report_metadata', {
        pane_id: 'w1:p1',
        source: 'orca',
        tokens: { orca_binding: 'abc123' }
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'report-metadata',
      'w1:p1',
      '--source',
      'orca',
      '--token',
      'orca_binding=abc123'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.report_metadata', {
        pane_id: 'w1:p2',
        source: 'orca',
        tokens: { orca_binding: null }
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'report-metadata',
      'w1:p2',
      '--source',
      'orca',
      '--clear-token',
      'orca_binding'
    ])
  })

  it('normalizes pane read text into the provider response contract', () => {
    const invocation = herdrStockCliInvocation('orca-app', 'pane.read', {
      pane_id: 'w1:p1',
      source: 'recent',
      lines: 80
    })
    expect(invocation.args).toContain('read')
    expect(invocation.parse('terminal output')).toMatchObject({
      result: { read: { text: 'terminal output', revision: 0 } }
    })
  })

  it('passes the recent-unwrapped source through pane read', () => {
    expect(
      herdrStockCliInvocation('orca-app', 'pane.read', {
        pane_id: 'w1:p1',
        source: 'recent-unwrapped',
        lines: 40
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'read',
      'w1:p1',
      '--source',
      'recent-unwrapped',
      '--lines',
      '40'
    ])
  })

  it('maps agent.get and agent.wait onto the stock CLI', () => {
    expect(herdrStockCliInvocation('orca-app', 'agent.get', { target: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'agent',
      'get',
      'w1:p1'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'agent.wait', {
        target: 'w1:p1',
        until: ['working', 'blocked'],
        timeout_ms: 5000
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'agent',
      'wait',
      'w1:p1',
      '--until',
      'working',
      '--until',
      'blocked',
      '--timeout',
      '5000'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'agent.wait', { target: 'w1:p1' }).parse(
        JSON.stringify({
          id: 'cli:agent:wait',
          result: {
            agent: { agent: 'claude', agent_status: 'working', pane_id: 'w1:p1' },
            type: 'agent_info'
          }
        })
      )
    ).toMatchObject({ result: { agent: { agent_status: 'working' } } })
  })

  it('maps pane.report_agent onto the stock CLI', () => {
    expect(
      herdrStockCliInvocation('orca-app', 'pane.report_agent', {
        pane_id: 'w1:p1',
        source: 'orca',
        agent: 'claude',
        state: 'working',
        message: 'reviewing diff'
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'report-agent',
      'w1:p1',
      '--source',
      'orca',
      '--agent',
      'claude',
      '--state',
      'working',
      '--message',
      'reviewing diff'
    ])
  })

  it('maps pane.zoom, pane.swap, pane.move and pane.resize onto the stock CLI', () => {
    expect(herdrStockCliInvocation('orca-app', 'pane.zoom', { pane_id: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'pane',
      'zoom',
      '--pane',
      'w1:p1',
      '--toggle'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.zoom', {
        pane_id: 'w1:p1',
        mode: 'off'
      }).args
    ).toEqual(['--session', 'orca-app', 'pane', 'zoom', '--pane', 'w1:p1', '--off'])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.swap', {
        source_pane_id: 'w1:p1',
        target_pane_id: 'w1:p2'
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'swap',
      '--source-pane',
      'w1:p1',
      '--target-pane',
      'w1:p2'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.swap', {
        direction: 'right',
        pane_id: 'w1:p1'
      }).args
    ).toEqual(['--session', 'orca-app', 'pane', 'swap', '--direction', 'right', '--pane', 'w1:p1'])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.move', {
        pane_id: 'w1:p1',
        destination: { type: 'tab', tab_id: 'w2:t1', split: 'right', ratio: 0.4 }
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'move',
      'w1:p1',
      '--tab',
      'w2:t1',
      '--split',
      'right',
      '--ratio',
      '0.4'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.move', {
        pane_id: 'w1:p1',
        destination: { type: 'new_tab', label: 'Moved' }
      }).args
    ).toEqual(['--session', 'orca-app', 'pane', 'move', 'w1:p1', '--new-tab', '--label', 'Moved'])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.move', {
        pane_id: 'w1:p1',
        destination: { type: 'new_workspace', label: 'WS', tab_label: 'T' }
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'move',
      'w1:p1',
      '--new-workspace',
      '--label',
      'WS',
      '--tab-label',
      'T'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.resize', {
        pane_id: 'w1:p1',
        direction: 'right',
        amount: '0.5'
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'resize',
      '--direction',
      'right',
      '--amount',
      '0.5',
      '--pane',
      'w1:p1'
    ])
  })

  it('maps notification.show onto the stock CLI and parses the envelope', () => {
    const invocation = herdrStockCliInvocation('orca-app', 'notification.show', {
      title: 'Agent done',
      body: 'claude finished',
      position: 'top-right',
      sound: 'done'
    })
    expect(invocation.args).toEqual([
      '--session',
      'orca-app',
      'notification',
      'show',
      'Agent done',
      '--body',
      'claude finished',
      '--position',
      'top-right',
      '--sound',
      'done'
    ])
    expect(
      invocation.parse(
        JSON.stringify({
          id: 'cli:notification:show',
          result: { reason: 'disabled', shown: false, type: 'notification_show' }
        })
      )
    ).toMatchObject({ result: { shown: false } })
  })

  it('maps worktree.open to the stock CLI and parses the opened envelope', () => {
    const invocation = herdrStockCliInvocation('orca-app', 'worktree.open', {
      cwd: '/repo/root',
      path: '/repo/wt',
      label: 'feature'
    })
    expect(invocation.args).toEqual([
      '--session',
      'orca-app',
      'worktree',
      'open',
      '--cwd',
      '/repo/root',
      '--path',
      '/repo/wt',
      '--label',
      'feature',
      '--no-focus'
    ])
    expect(
      invocation.parse(
        JSON.stringify({
          id: 'x',
          result: {
            type: 'worktree_opened',
            already_open: false,
            workspace: {},
            tab: {},
            root_pane: {}
          }
        })
      )
    ).toMatchObject({ result: { already_open: false } })
  })

  it('rejects fork-only API methods', () => {
    expect(() => herdrStockCliInvocation('orca-app', 'pane.bind', { pane_id: 'w1:p1' })).toThrow(
      'Unsupported stock Herdr CLI request'
    )
  })

  it('maps pane.send_text onto the stock CLI and normalizes the ok envelope', () => {
    const invocation = herdrStockCliInvocation('orca-app', 'pane.send_text', {
      pane_id: 'w1:p1',
      text: 'ls -la'
    })
    expect(invocation.args).toEqual([
      '--session',
      'orca-app',
      'pane',
      'send-text',
      'w1:p1',
      'ls -la'
    ])
    expect(invocation.parse('')).toMatchObject({ result: { type: 'ok' } })
  })

  it('maps pane.wait_for_output onto the stock CLI and parses the matched envelope', () => {
    const invocation = herdrStockCliInvocation('orca-app', 'pane.wait_for_output', {
      pane_id: 'w1:p1',
      source: 'recent',
      match: 'build finished',
      timeout_ms: 30000
    })
    expect(invocation.args).toEqual([
      '--session',
      'orca-app',
      'pane',
      'wait-output',
      'w1:p1',
      '--match',
      'build finished',
      '--source',
      'recent',
      '--timeout',
      '30000'
    ])
    expect(
      invocation.parse(
        JSON.stringify({
          id: 'cli:pane:wait-output',
          result: {
            matched_line: 'build finished in 12s',
            pane_id: 'w1:p1',
            read: { format: 'ansi', pane_id: 'w1:p1', revision: 3, text: '...', truncated: false },
            revision: 3,
            type: 'output_matched'
          }
        })
      )
    ).toMatchObject({ result: { matched_line: 'build finished in 12s', revision: 3 } })
  })

  it('maps pane.report_agent_session and pane.release_agent onto the stock CLI', () => {
    expect(
      herdrStockCliInvocation('orca-app', 'pane.report_agent_session', {
        pane_id: 'w1:p1',
        source: 'orca',
        agent: 'claude',
        agent_session_id: 'sess-1',
        agent_session_path: '/tmp/sess-1'
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'report-agent-session',
      'w1:p1',
      '--source',
      'orca',
      '--agent',
      'claude',
      '--agent-session-id',
      'sess-1',
      '--agent-session-path',
      '/tmp/sess-1'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.release_agent', {
        pane_id: 'w1:p1',
        source: 'orca',
        agent: 'claude',
        seq: 7
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'release-agent',
      'w1:p1',
      '--source',
      'orca',
      '--agent',
      'claude',
      '--seq',
      '7'
    ])
  })

  it('maps pane.layout, pane.neighbor and pane.edges onto the stock CLI', () => {
    expect(herdrStockCliInvocation('orca-app', 'pane.layout', { pane_id: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'pane',
      'layout',
      '--pane',
      'w1:p1'
    ])
    expect(herdrStockCliInvocation('orca-app', 'pane.layout', {}).args).toEqual([
      '--session',
      'orca-app',
      'pane',
      'layout',
      '--current'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.neighbor', {
        direction: 'right',
        pane_id: 'w1:p1'
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'pane',
      'neighbor',
      '--direction',
      'right',
      '--pane',
      'w1:p1'
    ])
    expect(herdrStockCliInvocation('orca-app', 'pane.edges', { pane_id: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'pane',
      'edges',
      '--pane',
      'w1:p1'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'pane.edges', {}).parse(
        JSON.stringify({
          id: 'cli:pane:edges',
          result: {
            edges: { down: true, left: false, pane_id: 'w1:p1', right: false, up: true },
            type: 'pane_edges'
          }
        })
      )
    ).toMatchObject({ result: { edges: { right: false } } })
  })

  it('maps agent.list and agent.read onto the stock CLI', () => {
    expect(herdrStockCliInvocation('orca-app', 'agent.list', {}).args).toEqual([
      '--session',
      'orca-app',
      'agent',
      'list'
    ])
    const readInvocation = herdrStockCliInvocation('orca-app', 'agent.read', {
      target: 'w1:p1',
      source: 'recent',
      lines: 20
    })
    expect(readInvocation.args).toEqual([
      '--session',
      'orca-app',
      'agent',
      'read',
      'w1:p1',
      '--source',
      'recent',
      '--lines',
      '20'
    ])
    expect(readInvocation.parse('claude: thinking')).toMatchObject({
      result: { read: { text: 'claude: thinking', revision: 0 } }
    })
  })

  it('maps agent.rename, agent.focus and agent.explain onto the stock CLI', () => {
    expect(
      herdrStockCliInvocation('orca-app', 'agent.rename', { target: 'w1:p1', name: 'reporter' })
        .args
    ).toEqual(['--session', 'orca-app', 'agent', 'rename', 'w1:p1', 'reporter'])
    expect(herdrStockCliInvocation('orca-app', 'agent.rename', { target: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'agent',
      'rename',
      'w1:p1',
      '--clear'
    ])
    expect(herdrStockCliInvocation('orca-app', 'agent.focus', { target: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'agent',
      'focus',
      'w1:p1'
    ])
    expect(herdrStockCliInvocation('orca-app', 'agent.explain', { target: 'w1:p1' }).args).toEqual([
      '--session',
      'orca-app',
      'agent',
      'explain',
      'w1:p1',
      '--json'
    ])
  })

  it('maps agent.start and agent.prompt onto the stock CLI', () => {
    expect(
      herdrStockCliInvocation('orca-app', 'agent.start', {
        name: 'coder',
        kind: 'claude',
        pane_id: 'w1:p1',
        timeout_ms: 60000,
        args: ['--model', 'sonnet']
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'agent',
      'start',
      'coder',
      '--kind',
      'claude',
      '--pane',
      'w1:p1',
      '--timeout',
      '60000',
      '--',
      '--model',
      'sonnet'
    ])
    expect(
      herdrStockCliInvocation('orca-app', 'agent.prompt', {
        target: 'w1:p1',
        text: 'review the diff',
        wait: true,
        until: ['working', 'done'],
        timeout_ms: 120000
      }).args
    ).toEqual([
      '--session',
      'orca-app',
      'agent',
      'prompt',
      'w1:p1',
      'review the diff',
      '--wait',
      '--until',
      'working',
      '--until',
      'done',
      '--timeout',
      '120000'
    ])
  })

  it('maps agent.send_keys onto the stock CLI', () => {
    expect(
      herdrStockCliInvocation('orca-app', 'agent.send_keys', {
        target: 'w1:p1',
        keys: ['ctrl+c']
      }).args
    ).toEqual(['--session', 'orca-app', 'agent', 'send-keys', 'w1:p1', 'ctrl+c'])
  })

  it('rejects agent.prompt and pane.send_text text that starts with a dash', () => {
    expect(() =>
      herdrStockCliInvocation('orca-app', 'agent.prompt', {
        target: 'w1:p1',
        text: '--force'
      })
    ).toThrow('must not start with a dash')
    expect(() =>
      herdrStockCliInvocation('orca-app', 'pane.send_text', {
        pane_id: 'w1:p1',
        text: '-n'
      })
    ).toThrow('must not start with a dash')
  })

  it('rejects a label that starts with a dash to prevent argument injection', () => {
    expect(() =>
      herdrStockCliInvocation('orca-app', 'workspace.create', { label: '--force' })
    ).toThrow('must not start with a dash')
    expect(() => herdrStockCliInvocation('orca-app', 'worktree.open', { label: '-x' })).toThrow(
      'must not start with a dash'
    )
    expect(() =>
      herdrStockCliInvocation('orca-app', 'tab.create', {
        workspace_id: 'w1',
        label: '--label'
      })
    ).toThrow('must not start with a dash')
  })

  it('rejects pane.send_keys values that start with a dash to prevent argument injection', () => {
    expect(() =>
      herdrStockCliInvocation('orca-app', 'pane.send_keys', {
        pane_id: 'w1:p1',
        keys: ['--json']
      })
    ).toThrow('must not start with a dash')
    expect(() =>
      herdrStockCliInvocation('orca-app', 'pane.send_keys', {
        pane_id: 'w1:p1',
        keys: ['echo', '--json']
      })
    ).toThrow('must not start with a dash')
  })
})
