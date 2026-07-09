import { exec, spawn, type ChildProcess } from 'node:child_process'
import { resolveCliCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'

export type SpawnWikiAgentInput = {
  binary: string
  args: string[]
  cwd: string
  prompt: string
  promptViaStdin: boolean
}

// Why: mirrors commit-message-text-generation.ts's local spawn shape so the
// headless wiki agent resolves the same Windows .cmd shims and cwd/env rules.
export function spawnWikiAgent(input: SpawnWikiAgentInput): ChildProcess {
  const spawnEnv = process.env
  const resolvedBinary =
    process.platform === 'win32'
      ? resolveCliCommand(input.binary, { pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null })
      : input.binary
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(resolvedBinary, input.args)
  const child = spawn(spawnCmd, spawnArgs, {
    cwd: input.cwd,
    env: spawnEnv,
    // Why: detached so killProcessTree can signal the whole process group on
    // POSIX; Windows has no process groups so taskkill walks the tree instead.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  if (input.promptViaStdin) {
    child.stdin?.end(input.prompt)
  }
  return child
}

// Why: on Windows, npm-installed CLIs are usually .cmd shims, so child.kill()
// only terminates the wrapper. taskkill /T /F walks the process tree from the
// wrapper PID. On POSIX, the negative pid targets the whole detached group.
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    return
  }
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${pid} /T /F`, () => {
      // Best-effort; the spawn's `close` listener fires once the tree exits.
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // The child may have already exited between the in-flight check and the
      // kill - that race is benign and can be ignored.
    }
  }
}
