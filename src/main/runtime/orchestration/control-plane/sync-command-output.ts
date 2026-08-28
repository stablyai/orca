import { runProcessSync } from '../../../../shared/child-process/run-process'

/** `execFileSync` semantics on top of the sanctioned runner.
 *
 *  Direct `child_process` use is ratcheted shut repo-wide (it pins windowsHide,
 *  refuses `shell: true`, and encodes `.cmd` arguments safely), so the few
 *  control-plane call sites that genuinely want "run it, give me stdout, throw
 *  on failure" share this instead of reaching past the boundary.
 */
export function runCommandForStdout(args: {
  program: string
  args: readonly string[]
  cwd?: string
  input?: string
  timeoutMs?: number
  maxOutputBytes?: number
}): string {
  const result = runProcessSync({
    program: args.program,
    args: [...args.args],
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    ...(args.input === undefined ? {} : { input: args.input }),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    ...(args.maxOutputBytes === undefined ? {} : { maxOutputBytes: args.maxOutputBytes })
  })
  if (result.code !== 0) {
    throw new Error(
      `${args.program} exited ${result.code ?? 'by signal'} ${result.signal ?? ''}: ${result.stderr.trim()}`
    )
  }
  return result.stdout
}
