const WATCH_ARGS = new Set(['-w', '--watch'])

/** The `--changed` ref of a one-shot run: true for the bare flag, undefined when absent or ambiguous. */
export function parseChangedArg(args) {
  if (args[0] !== 'run' || args.some((arg) => WATCH_ARGS.has(arg.split('=')[0]))) {
    return undefined
  }
  const index = args.findIndex((arg) => arg === '--changed' || arg.startsWith('--changed='))
  if (index === -1) {
    return undefined
  }
  const arg = args[index]
  if (arg !== '--changed') {
    return arg.slice('--changed='.length) || undefined
  }
  // Vitest would read a following positional as the ref; leave that form to Vitest.
  const next = args[index + 1]
  return next === undefined || next.startsWith('-') ? true : undefined
}

/**
 * Whether Git reports no changed files for Vitest's `--changed`, which then runs nothing, so the
 * caller can skip starting it. Any doubt returns false.
 */
export async function hasNoChangedFiles(args, root, runProcess) {
  const changed = parseChangedArg(args)
  if (changed === undefined) {
    return false
  }
  const queries = [
    // Covers Vitest's staged, modified, and untracked queries. Unlike `ls-files --modified`, it
    // refreshes stale index stat data instead of rehashing files on every run.
    ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    ...(typeof changed === 'string' ? [['diff', '--name-only', '-z', `${changed}...HEAD`]] : [])
  ]
  try {
    const results = await Promise.all(
      queries.map((args) =>
        runProcess({ program: 'git', args, cwd: root, timeoutMs: 30_000, maxOutputBytes: 4096 })
      )
    )
    return results.every((result) => result.code === 0 && result.stdout === '')
  } catch {
    return false
  }
}
