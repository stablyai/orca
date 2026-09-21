import path from 'node:path'
import { buildRelayCommandEnv } from './relay-command-env'
import { runProcess } from '../shared/child-process/run-process'

const IDENTITY_PROBE_TIMEOUT_MS = 5000

/** `<executable> --version` output, or null when the probe cannot answer. */
export async function probeCommandVersion(executablePath: string): Promise<string | null> {
  try {
    const env = buildRelayCommandEnv(process.env, process.platform)
    const pathKey = process.platform === 'win32' && env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: ['--version'],
      env: {
        ...env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
    if (result.code !== 0) {
      return null
    }
    const output = `${result.stdout}\n${result.stderr}`.trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

/** Runs an agent's identity probe against its resolved path; throws when it cannot answer. */
export async function runIdentityProbe(
  program: string | undefined,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  if (!program) {
    throw new Error('no resolved path to probe')
  }
  // Why runProcess: it starts Windows `.cmd` shims, which execFile cannot without a shell.
  const result = await runProcess({
    program,
    args,
    env: buildRelayCommandEnv(process.env, process.platform),
    timeoutMs: IDENTITY_PROBE_TIMEOUT_MS
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`${program} exited with ${result.code ?? result.signal ?? 'timeout'}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}
