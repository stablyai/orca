// Leaf module avoids a cycle between wrapper templates, their fileset builder and content-addressed root.
export const SHELL_READY_MARKER_ESCAPED = '\\033]777;orca-shell-ready\\007'
