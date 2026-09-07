/**
 * The marker the local shell-ready wrappers emit once startup files finish.
 *
 * Why its own module: the wrapper file-set builder needs it, and so do the
 * rcfile templates that builder pulls in. Keeping it as a leaf lets the wrapper
 * root import the builder (to hash it) without a cycle.
 */
export const SHELL_READY_MARKER_ESCAPED = '\\033]777;orca-shell-ready\\007'
