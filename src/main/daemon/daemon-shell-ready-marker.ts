// Why: shells re-escape this when the wrapper templates interpolate it, so the
// backslashes stay literal here and only become ESC/BEL once printf runs.
export const SHELL_READY_MARKER = '\\033]777;orca-shell-ready\\007'
