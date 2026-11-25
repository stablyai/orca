/** Log the resolved wrapper on deadline kills; omit argv because headers and bodies can contain credentials. */
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
