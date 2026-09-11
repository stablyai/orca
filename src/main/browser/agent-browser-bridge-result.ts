import { classifyErrorCode } from './agent-browser-bridge-process'

export function translateResult(
  stdout: string
): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
  let parsed: { success?: boolean; data?: unknown; error?: string }
  try {
    parsed = JSON.parse(stdout)
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
