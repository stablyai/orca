/**
 * One log line when `gh`/`glab` is killed at its deadline without answering.
 *
 * Why this exists: the deadline kill was completely silent. In #18234 a user's
 * `~/.local/bin/gh` wrapper (`exec mise x gh -- gh "$@"`) re-execed itself in
 * place at 100% CPU on every invocation, and the only evidence Orca produced was
 * that GitHub features quietly did nothing. Diagnosing it took the reporter four
 * rounds of `strace`, `perf` and `/proc` spelunking. The resolved path below is
 * the single most useful fact — it names the wrapper.
 *
 * Why not the full argv: `gh api` carries `-H Authorization: …` and `--field`
 * bodies, so only the subcommand and an argument count are safe to print.
 */
export function logHostedCliDeadlineKill(
  cli: string,
  resolvedBinary: string,
  args: readonly string[],
  timeoutMs: number
): void {
  const subcommand = args[0] ?? '(none)'
  console.warn(
    `[${cli}] killed at its ${timeoutMs}ms deadline without answering — ` +
      `subcommand "${subcommand}" (${args.length} args), resolved to "${resolvedBinary}". ` +
      `If that path is a wrapper script, check that it resolves the real ${cli} binary rather than itself.`
  )
}
