import { runProcess } from '../shared/child-process/run-process'
import { resolveWslInteropSpawnCwd } from './wsl-interop-spawn-directory'

/**
 * Run `wsl.exe` (or any program) to completion and return its stdout, rejecting
 * on a non-zero exit, a timeout, or a failure to start -- the same contract
 * `execFile`'s callback gave its callers.
 *
 * Why `runProcess` and not `execFile`: without a termination barrier, a timeout
 * kills only this process's root and leaves whatever holds its console behind
 * -- the same execFile-timeout defect `runWslProcess` and `probeGuestEnvironment`
 * were fixed for (see wsl-runner.ts, wsl-guest-environment.ts). `windowsHide`
 * comes free via run-process.ts's resolveSpawn, fixing the flashed console this
 * callback-style execFile call never set either.
 *
 * Split out of wsl.ts to keep it under the file's line budget.
 */
export async function execFileUtf8(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const result = await runProcess({
    program: command,
    args,
    env,
    timeoutMs: 5000,
    cwd: resolveWslInteropSpawnCwd(),
    terminationBarrier: true
  })
  if (result.timedOut) {
    throw Object.assign(new Error(`${command} timed out`), {
      code: 'ETIMEDOUT',
      killed: true,
      signal: result.signal
    })
  }
  if (result.code !== 0) {
    throw Object.assign(new Error(`${command} exited with code ${result.code}`), {
      code: result.code,
      signal: result.signal
    })
  }
  return result.stdout
}
