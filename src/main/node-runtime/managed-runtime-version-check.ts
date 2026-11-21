import { runProcess } from '@orca/process-host'
import { ManagedRuntimeStartError } from './managed-runtime-release'

const VALIDATE_TIMEOUT_MS = 60_000

/** Run `<program> --version` without user credentials; reject unless it answers `expected`. */
export async function requireRuntimeAnswersVersion(
  program: string,
  label: string,
  expected: string,
  answers: (stdout: string) => boolean,
  signal: AbortSignal,
  /** Added to the inherited environment, e.g. to keep a self-updating CLI from updating. */
  env?: Readonly<Record<string, string>>
): Promise<void> {
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program,
      args: ['--version'],
      ...(env && { env: { ...process.env, ...env } }),
      timeoutMs: VALIDATE_TIMEOUT_MS,
      signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ManagedRuntimeStartError(
      message,
      { kind: 'exit', exit: { code: null, signal: null, processless: true }, stderr: '' },
      { cause: error }
    )
  }
  signal.throwIfAborted()
  if (result.timedOut) {
    throw new ManagedRuntimeStartError(`${label} did not answer`, {
      kind: 'timeout',
      timeoutMs: VALIDATE_TIMEOUT_MS
    })
  }
  if (result.code !== 0) {
    throw new ManagedRuntimeStartError(`${label} exited`, {
      kind: 'exit',
      exit: { code: result.code, signal: result.signal, processless: false },
      stderr: result.stderr
    })
  }
  const answered = result.stdout.trim()
  if (!answers(answered)) {
    throw new ManagedRuntimeStartError(`${label} answered with another version`, {
      kind: 'version',
      answered,
      expected
    })
  }
}
