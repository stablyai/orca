// Why: the CLI build cannot import main-process modules, so these mirror the debug.* RPC results.
export type DebugRefusal = { ok: false; reason: string; message: string }
export type DebugResult<T> = { ok: true; value: T } | DebugRefusal

export type DebugBreakpoint = {
  id: string
  path: string
  line: number
  enabled: boolean
  condition?: string
  hitCondition?: string
  logMessage?: string
  /** Who last set its condition, hit condition or log message. */
  author?: 'ui' | 'cli'
  answer: {
    state: 'verified' | 'pending' | 'failed' | 'unsupported'
    message?: string
  }
}

export type DebugSnapshot = {
  seq: number
  worktreePath: string
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'terminated' | 'failed'
  configName: string | null
  adapterId: string | null
  stopped: {
    reason: string
    threadId: number
    allThreadsStopped: boolean
    description?: string
  } | null
  threads: { id: number; name: string }[]
  breakpoints: DebugBreakpoint[]
  lastError: string | null
}

export type DebugConfigListing = {
  name: string
  kind: 'configuration' | 'compound'
  type: string
  request: string
  runnable: boolean
  refusal?: string
}

export type DebugStackResult = {
  threadId: number
  stackFrames: {
    id: number
    name: string
    source?: { name?: string; path?: string }
    line: number
    column: number
  }[]
  totalFrames?: number
}

export type DebugVariableNode = {
  name: string
  value: string
  type?: string
  variablesReference: number
  children?: DebugVariableNode[]
}

export type DebugVariablesResult = {
  frameId?: number
  scope?: string
  variablesReference: number
  variables: DebugVariableNode[]
  truncated: boolean
}

export type DebugEvaluateResult = {
  result: string
  type?: string
  variablesReference: number
}

export type DebugEventsPage = {
  events: (
    | { seq: number; ts: number; category: string; text: string }
    | { kind: 'state'; seq: number; status: string }
  )[]
  latestSeq: number
  truncated: boolean
}

export type DebugWaitResult = { timedOut: boolean; snapshot: DebugSnapshot }

const isControl = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)

/**
 * Drops C0 and C1 control characters except tab and newline. Why: program output, values, names
 * and repo paths reach a terminal here, and an escape sequence in them could rewrite the screen.
 * --json stays raw (JSON.stringify escapes them).
 */
export function terminalSafe(text: string): string {
  return [...text].filter((char) => !isControl(char.charCodeAt(0))).join('')
}

/** Wraps a value formatter so a refusal prints its reason instead; every line is terminal-safe. */
export function formatDebugResult<T>(
  format: (value: T) => string
): (result: DebugResult<T>) => string {
  return (result) =>
    terminalSafe(result.ok ? format(result.value) : `Refused (${result.reason}): ${result.message}`)
}

export function formatDebugStatus(snapshot: DebugSnapshot): string {
  const parts: string[] = [snapshot.status]
  if (snapshot.stopped) {
    const { reason, threadId, description } = snapshot.stopped
    parts[0] = `stopped (${description ?? reason}) on thread ${threadId}`
  }
  if (snapshot.configName !== null) {
    parts.push(`config "${snapshot.configName}"`)
  }
  if (snapshot.adapterId !== null) {
    parts.push(`adapter ${snapshot.adapterId}`)
  }
  parts.push(`${snapshot.breakpoints.length} breakpoint(s)`)
  if (snapshot.lastError !== null) {
    parts.push(`error: ${snapshot.lastError}`)
  }
  return parts.join(' · ')
}

export function formatDebugConfigs(configs: DebugConfigListing[]): string {
  if (configs.length === 0) {
    return 'No launch configurations.'
  }
  return configs
    .map((config) => {
      const line = `${config.name}  (${config.kind === 'compound' ? 'compound' : `${config.type} ${config.request}`})`
      return config.runnable ? line : `${line}  not runnable: ${config.refusal ?? 'unknown'}`
    })
    .join('\n')
}

export function formatDebugStack(result: DebugStackResult): string {
  if (result.stackFrames.length === 0) {
    return `No frames on thread ${result.threadId}.`
  }
  return result.stackFrames
    .map((frame, index) => {
      const where = frame.source?.path ?? frame.source?.name ?? '<unknown>'
      return `#${index} ${frame.name}  ${where}:${frame.line}`
    })
    .join('\n')
}

function variableLines(nodes: DebugVariableNode[], indent: string): string[] {
  return nodes.flatMap((node) => {
    const type = node.type ? `: ${node.type}` : ''
    const line = `${indent}${node.name}${type} = ${node.value}`
    return [line, ...variableLines(node.children ?? [], `${indent}  `)]
  })
}

export function formatDebugVariables(result: DebugVariablesResult): string {
  const lines = result.scope === undefined ? [] : [`${result.scope}:`]
  const indent = result.scope === undefined ? '' : '  '
  lines.push(...variableLines(result.variables, indent))
  if (result.variables.length === 0) {
    lines.push(`${indent}(no variables)`)
  }
  if (result.truncated) {
    lines.push('(truncated: too many variables; narrow with --ref or a lower --depth)')
  }
  return lines.join('\n')
}

export function formatDebugEvaluate(result: DebugEvaluateResult): string {
  return result.result
}

export function formatDebugEvents(page: DebugEventsPage): string {
  const lines = page.events.map((event) =>
    'kind' in event ? `[${event.status}]` : event.text.replace(/\r?\n$/, '')
  )
  if (page.truncated) {
    lines.unshift('Some earlier events were evicted; showing what remains.')
  }
  lines.push(`latestSeq: ${page.latestSeq}`)
  return lines.join('\n')
}

export function formatDebugWait(result: DebugWaitResult): string {
  const status = formatDebugStatus(result.snapshot)
  return result.timedOut ? `Timed out; ${status}` : status
}

export function formatDebugBreakpoint(bp: DebugBreakpoint): string {
  const extras = [
    bp.enabled ? '' : 'disabled',
    bp.condition ? `if ${bp.condition}` : '',
    bp.hitCondition ? `hit ${bp.hitCondition}` : '',
    bp.logMessage ? `log "${bp.logMessage}"` : ''
  ].filter((extra) => extra.length > 0)
  const suffix = extras.length === 0 ? '' : `  ${extras.join(' ')}`
  const note = bp.answer.message ? `  (${bp.answer.message})` : ''
  return `${bp.path}:${bp.line} [${bp.answer.state}]${suffix}${note}`
}

export function formatDebugBreakpoints(breakpoints: DebugBreakpoint[]): string {
  if (breakpoints.length === 0) {
    return 'No breakpoints.'
  }
  return breakpoints.map(formatDebugBreakpoint).join('\n')
}
