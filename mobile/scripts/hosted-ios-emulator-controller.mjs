import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { startHeadlessPairingRuntime } from './start-emulator-pairing-runtime.mjs'

const execFileAsync = promisify(execFile)

export async function startHostedIosEmulatorController(
  { orcaCli, runtimeDirectory, worktree },
  startRuntime = startHeadlessPairingRuntime,
  runCli = execFileAsync
) {
  const runtime = await startRuntime({
    enabled: true,
    orcaCli,
    cwd: worktree,
    runDirectory: path.join(runtimeDirectory, 'emulator-control'),
    lanIpCandidates: () => ['127.0.0.1'],
    logStep: () => {},
    logSuccess: () => {}
  })
  try {
    await runCli(orcaCli, ['repo', 'add', '--path', worktree, '--json'], {
      cwd: worktree,
      env: runtime.env,
      timeout: 60_000
    })
    return runtime
  } catch (error) {
    await runtime.stop()
    throw error
  }
}
