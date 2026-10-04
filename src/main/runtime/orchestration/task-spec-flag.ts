/** Opt-in `<name>: true` lines that coordinators put in a task spec. */

// Why (§3.4): flags live in the spec text (no DB column); the match is narrow so typos fail closed, and stripping keeps the infra line out of the worker's TASK block.
// Trade-off (§7.9): matches any spec line, even inside fenced code.
export function parseTaskSpecFlag(
  spec: string,
  name: string
): { enabled: boolean; strippedSpec: string } {
  const line = new RegExp(`^[ \\t]*${name}:[ \\t]*true[ \\t]*\\r?(?:\\n|$)`, 'im')
  if (!line.test(spec)) {
    return { enabled: false, strippedSpec: spec }
  }
  return { enabled: true, strippedSpec: spec.replace(line, '') }
}
