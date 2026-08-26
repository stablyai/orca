import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'
import { redactString } from '../../../observability/redactor'
import { redactWorkerTerminalLines } from '../../orchestration/worker-transcript-payload'

const READINESS_DIAGNOSTIC_MAX_LINES = 20
const READINESS_DIAGNOSTIC_MAX_CHARS = 4_000
const READINESS_DIAGNOSTIC_TRUNCATED = '… (diagnostic output truncated)'

export function getAgentReadinessFailure(
  wait: RuntimeTerminalWait,
  terminalLines: readonly string[] = []
): string | null {
  if (wait.satisfied && wait.status === 'running') {
    return null
  }
  let summary: string
  if (wait.blockedReason) {
    summary = `Agent startup blocked: ${wait.blockedReason}`
  } else if (wait.status === 'exited') {
    const code = wait.exitCode === null ? '' : ` with code ${wait.exitCode}`
    summary = `Agent process exited before becoming ready${code}.`
  } else {
    summary = `Agent did not become ready (${wait.status}).`
  }
  const diagnostic = buildReadinessDiagnostic(terminalLines)
  return diagnostic ? `${summary}\nDiagnostic output:\n${diagnostic}` : summary
}

function buildReadinessDiagnostic(lines: readonly string[]): string {
  const selected = lines.slice(-READINESS_DIAGNOSTIC_MAX_LINES)
  const dispatchRedacted = redactWorkerTerminalLines(selected).lines.join('\n')
  const output = redactString(dispatchRedacted).trim()
  if (!output) {
    return ''
  }
  const wasTruncated =
    selected.length < lines.length || output.length > READINESS_DIAGNOSTIC_MAX_CHARS
  if (!wasTruncated) {
    return output
  }
  const contentBudget = READINESS_DIAGNOSTIC_MAX_CHARS - READINESS_DIAGNOSTIC_TRUNCATED.length - 1
  return `${READINESS_DIAGNOSTIC_TRUNCATED}\n${output.slice(-contentBudget)}`
}
