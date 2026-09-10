export function linearListFlagHelp(flag: string): string | undefined {
  if (flag === 'cursor') {
    return '--cursor <cursor>      Opaque cursor from a previous list-issues page; issued cursors bind the workspace, raw Linear cursors need --workspace'
  }
  if (flag === 'page-recovery') {
    return '--page-recovery <vector> Resume an admitted batch with --workspace all on a capable runtime; cannot use --cursor'
  }
  if (flag === 'priority') {
    return '--priority <0-4>       0=none, 1=urgent, 2=high, 3=medium, 4=low'
  }
  if (flag === 'limit') {
    return '--limit <n>            Max issues to return; omit to read until exhaustion or a capacity/time stop'
  }
  if (flag === 'workspace') {
    return '--workspace <id|all>  Connected Linear workspace id, or all'
  }
  return undefined
}
