import {
  agentStartArgs,
  asRecord,
  assertNoLeadingDash,
  moveDestinationFlags,
  optionalFlag,
  optionalLabelFlag,
  optionalString,
  outputMatchFlags,
  paneTargetFlags,
  renameTargetFlags,
  requiredString,
  requiredStrings,
  swapTargetFlags,
  tokenFlags,
  untilFlags,
  zoomMode
} from './herdr-stock-cli-flags'

export function herdrStockCliArgs(method: string, rawParams: unknown): string[] {
  const params = asRecord(rawParams)
  switch (method) {
    case 'workspace.create':
      return [
        'workspace',
        'create',
        ...optionalFlag('--cwd', params.cwd),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'workspace.list':
      return ['workspace', 'list']
    case 'workspace.get':
      return ['workspace', 'get', requiredString(params.workspace_id, 'workspace_id')]
    case 'workspace.focus':
      return ['workspace', 'focus', requiredString(params.workspace_id, 'workspace_id')]
    case 'workspace.rename':
      return [
        'workspace',
        'rename',
        requiredString(params.workspace_id, 'workspace_id'),
        requiredString(params.label, 'label')
      ]
    case 'workspace.report_metadata':
      return [
        'workspace',
        'report-metadata',
        requiredString(params.workspace_id, 'workspace_id'),
        '--source',
        requiredString(params.source, 'source'),
        ...tokenFlags(params.tokens)
      ]
    case 'workspace.close':
      return ['workspace', 'close', requiredString(params.workspace_id, 'workspace_id')]
    case 'worktree.open':
      return [
        'worktree',
        'open',
        ...optionalFlag('--cwd', params.cwd),
        ...optionalFlag('--path', params.path),
        ...optionalFlag('--branch', params.branch),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'worktree.list':
      return ['worktree', 'list', ...optionalFlag('--cwd', params.cwd)]
    case 'worktree.create':
      return [
        'worktree',
        'create',
        ...optionalFlag('--cwd', params.cwd),
        ...optionalFlag('--path', params.path),
        ...optionalFlag('--branch', params.branch),
        ...optionalFlag('--base', params.base),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'worktree.remove':
      return [
        'worktree',
        'remove',
        requiredString(params.workspace_id, 'workspace_id'),
        ...(params.force ? ['--force'] : [])
      ]
    case 'tab.create':
      return [
        'tab',
        'create',
        '--workspace',
        requiredString(params.workspace_id, 'workspace_id'),
        ...optionalFlag('--cwd', params.cwd),
        ...optionalLabelFlag(params.label),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'tab.list':
      return ['tab', 'list', ...optionalFlag('--workspace', params.workspace_id)]
    case 'tab.get':
      return ['tab', 'get', requiredString(params.tab_id, 'tab_id')]
    case 'tab.focus':
      return ['tab', 'focus', requiredString(params.tab_id, 'tab_id')]
    case 'tab.rename':
      return [
        'tab',
        'rename',
        requiredString(params.tab_id, 'tab_id'),
        requiredString(params.label, 'label')
      ]
    case 'tab.move':
      return [
        'tab',
        'move',
        requiredString(params.tab_id, 'tab_id'),
        '--insert-index',
        requiredString(params.insert_index, 'insert_index')
      ]
    case 'tab.close':
      return ['tab', 'close', requiredString(params.tab_id, 'tab_id')]
    case 'pane.split':
      return [
        'pane',
        'split',
        requiredString(params.target_pane_id, 'target_pane_id'),
        '--direction',
        requiredString(params.direction, 'direction'),
        ...optionalFlag('--ratio', params.ratio),
        ...optionalFlag('--cwd', params.cwd),
        params.focus ? '--focus' : '--no-focus'
      ]
    case 'pane.get':
      return ['pane', 'get', requiredString(params.pane_id, 'pane_id')]
    case 'pane.focus':
      return ['pane', 'focus', requiredString(params.pane_id, 'pane_id')]
    case 'pane.list':
      return ['pane', 'list', ...optionalFlag('--workspace', params.workspace_id)]
    case 'pane.current':
      return ['pane', 'current', ...optionalFlag('--caller-pane-id', params.caller_pane_id)]
    case 'pane.process_info':
      return ['pane', 'process-info', ...paneTargetFlags(params)]
    case 'pane.read':
      return [
        'pane',
        'read',
        requiredString(params.pane_id, 'pane_id'),
        '--source',
        optionalString(params.source) ?? 'recent',
        ...optionalFlag('--lines', params.lines),
        ...(params.strip_ansi === false ? ['--no-strip-ansi'] : []),
        ...(params.format === 'ansi' ? ['--format', 'ansi'] : [])
      ]
    case 'pane.send_keys':
      return [
        'pane',
        'send-keys',
        requiredString(params.pane_id, 'pane_id'),
        ...requiredStrings(params.keys, 'keys')
      ]
    case 'pane.send_text':
      return [
        'pane',
        'send-text',
        requiredString(params.pane_id, 'pane_id'),
        assertNoLeadingDash(requiredString(params.text, 'text'), 'text')
      ]
    case 'pane.wait_for_output':
      return [
        'pane',
        'wait-output',
        requiredString(params.pane_id, 'pane_id'),
        ...outputMatchFlags(params),
        ...optionalFlag('--source', params.source),
        ...optionalFlag('--lines', params.lines),
        ...optionalFlag('--timeout', params.timeout_ms)
      ]
    case 'pane.report_metadata':
      return [
        'pane',
        'report-metadata',
        requiredString(params.pane_id, 'pane_id'),
        '--source',
        requiredString(params.source, 'source'),
        ...tokenFlags(params.tokens),
        ...optionalFlag('--title', params.title),
        ...optionalFlag('--display-agent', params.display_agent),
        ...optionalFlag('--ttl', params.ttl_ms),
        ...optionalFlag('--seq', params.seq),
        ...(params.clear_title ? ['--clear-title'] : []),
        ...(params.clear_display_agent ? ['--clear-display-agent'] : []),
        ...(params.clear_state_labels ? ['--clear-state-labels'] : [])
      ]
    case 'pane.report_agent':
      return [
        'pane',
        'report-agent',
        requiredString(params.pane_id, 'pane_id'),
        '--source',
        requiredString(params.source, 'source'),
        '--agent',
        requiredString(params.agent, 'agent'),
        '--state',
        requiredString(params.state, 'state'),
        ...optionalFlag('--message', params.message),
        ...optionalFlag('--agent-session-id', params.agent_session_id),
        ...optionalFlag('--agent-session-path', params.agent_session_path),
        ...optionalFlag('--seq', params.seq)
      ]
    case 'pane.report_agent_session':
      return [
        'pane',
        'report-agent-session',
        requiredString(params.pane_id, 'pane_id'),
        '--source',
        requiredString(params.source, 'source'),
        '--agent',
        requiredString(params.agent, 'agent'),
        ...optionalFlag('--agent-session-id', params.agent_session_id),
        ...optionalFlag('--agent-session-path', params.agent_session_path),
        ...optionalFlag('--session-start-source', params.session_start_source),
        ...optionalFlag('--seq', params.seq)
      ]
    case 'pane.release_agent':
      return [
        'pane',
        'release-agent',
        requiredString(params.pane_id, 'pane_id'),
        '--source',
        requiredString(params.source, 'source'),
        '--agent',
        requiredString(params.agent, 'agent'),
        ...optionalFlag('--seq', params.seq)
      ]
    case 'pane.close':
      return ['pane', 'close', requiredString(params.pane_id, 'pane_id')]
    case 'pane.rename':
      return [
        'pane',
        'rename',
        requiredString(params.pane_id, 'pane_id'),
        ...optionalLabelFlag(params.label)
      ]
    case 'pane.layout':
      return ['pane', 'layout', ...paneTargetFlags(params)]
    case 'pane.neighbor':
      return [
        'pane',
        'neighbor',
        '--direction',
        requiredString(params.direction, 'direction'),
        ...paneTargetFlags(params)
      ]
    case 'pane.edges':
      return ['pane', 'edges', ...paneTargetFlags(params)]
    case 'pane.zoom':
      return ['pane', 'zoom', ...paneTargetFlags(params), `--${zoomMode(params.mode)}`]
    case 'pane.swap':
      return ['pane', 'swap', ...swapTargetFlags(params)]
    case 'pane.move':
      return [
        'pane',
        'move',
        requiredString(params.pane_id, 'pane_id'),
        ...moveDestinationFlags(params)
      ]
    case 'pane.resize':
      return [
        'pane',
        'resize',
        '--direction',
        requiredString(params.direction, 'direction'),
        ...optionalFlag('--amount', params.amount),
        ...paneTargetFlags(params)
      ]
    case 'agent.list':
      return ['agent', 'list']
    case 'agent.get':
      return ['agent', 'get', requiredString(params.target, 'target')]
    case 'agent.wait':
      return [
        'agent',
        'wait',
        requiredString(params.target, 'target'),
        ...untilFlags(params.until),
        ...optionalFlag('--timeout', params.timeout_ms)
      ]
    case 'agent.read':
      return [
        'agent',
        'read',
        requiredString(params.target, 'target'),
        ...optionalFlag('--source', params.source),
        ...optionalFlag('--lines', params.lines),
        ...(params.strip_ansi === false ? ['--no-strip-ansi'] : []),
        ...(params.format === 'ansi' ? ['--format', 'ansi'] : [])
      ]
    case 'agent.rename':
      return [
        'agent',
        'rename',
        requiredString(params.target, 'target'),
        ...renameTargetFlags(params.name)
      ]
    case 'agent.focus':
      return ['agent', 'focus', requiredString(params.target, 'target')]
    case 'agent.explain':
      return ['agent', 'explain', requiredString(params.target, 'target'), '--json']
    case 'agent.start':
      return [
        'agent',
        'start',
        requiredString(params.name, 'name'),
        '--kind',
        requiredString(params.kind, 'kind'),
        '--pane',
        requiredString(params.pane_id, 'pane_id'),
        ...optionalFlag('--timeout', params.timeout_ms),
        ...agentStartArgs(params.args)
      ]
    case 'agent.prompt':
      return [
        'agent',
        'prompt',
        requiredString(params.target, 'target'),
        assertNoLeadingDash(requiredString(params.text, 'text'), 'text'),
        ...(params.wait ? ['--wait'] : []),
        ...untilFlags(params.until),
        ...optionalFlag('--timeout', params.timeout_ms)
      ]
    case 'agent.send_keys':
      return [
        'agent',
        'send-keys',
        requiredString(params.target, 'target'),
        ...requiredStrings(params.keys, 'keys')
      ]
    case 'session.snapshot':
      return ['api', 'snapshot']
    case 'notification.show':
      return [
        'notification',
        'show',
        requiredString(params.title, 'title'),
        ...optionalFlag('--body', params.body),
        ...optionalFlag('--position', params.position),
        ...optionalFlag('--sound', params.sound)
      ]
    case 'server.live_handoff':
      return [
        'server',
        'live-handoff',
        ...optionalFlag('--expected-protocol', params.expected_protocol),
        ...optionalFlag('--expected-version', params.expected_version),
        ...optionalFlag('--import-exe', params.import_exe)
      ]
    default:
      throw new Error(`Unsupported stock Herdr CLI request: ${method}`)
  }
}
