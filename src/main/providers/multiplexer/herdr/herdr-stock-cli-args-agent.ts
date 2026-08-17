import {
  agentStartArgs,
  asRecord,
  assertNoLeadingDash,
  optionalFlag,
  renameTargetFlags,
  requiredString,
  requiredStrings,
  untilFlags
} from './herdr-stock-cli-flags'

export function agentCliArgs(method: string, rawParams: unknown): string[] | null {
  const params = asRecord(rawParams)
  switch (method) {
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
    default:
      return null
  }
}
