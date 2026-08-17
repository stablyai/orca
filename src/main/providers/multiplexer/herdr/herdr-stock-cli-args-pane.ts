import {
  asRecord,
  assertNoLeadingDash,
  moveDestinationFlags,
  optionalFlag,
  optionalLabelFlag,
  optionalString,
  outputMatchFlags,
  paneTargetFlags,
  requiredString,
  requiredStrings,
  swapTargetFlags,
  tokenFlags,
  zoomMode
} from './herdr-stock-cli-flags'

export function paneCliArgs(method: string, rawParams: unknown): string[] | null {
  const params = asRecord(rawParams)
  switch (method) {
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
    default:
      return null
  }
}
