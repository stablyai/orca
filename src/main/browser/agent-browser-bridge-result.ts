import { classifyErrorCode } from './agent-browser-bridge-process'
import {
  parseAgentBrowserJsonOutput,
  type AgentBrowserEnvelope
} from './agent-browser-batch-command'

export function translateResult(
  stdout: string,
  options?: { cliArgv?: boolean }
): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  let parsed: AgentBrowserEnvelope
  try {
    parsed = parseAgentBrowserJsonOutput(stdout, options)
  } catch {
    return {
      ok: false,
      error: {
        code: 'browser_error',
        message: `Unexpected output from agent-browser: ${stdout.slice(0, 1000)}`
      }
    }
  }
  if (parsed.success) {
    return { ok: true, result: parsed.data }
  }
  const message = parsed.error ?? 'Unknown browser error'
  return {
    ok: false,
    error: {
      code: classifyErrorCode(message),
      message
    }
  }
}
