import {
  LAYOUT_OWNER_ENV,
  LAYOUT_OWNER_RESOLVED_ENV
} from '../../../shared/workspace-layout/layout-owner-startup'

export function stripInheritedBuildModeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Orca inherits its own build mode; leaking it changes user next/Vitest behavior. Explicit spawn env and rc files still win.
  const next = { ...env }
  delete next.NODE_ENV
  // Orca's layout path would turn the new path on in a user's Vitest run or an Orca launched from this shell.
  delete next[LAYOUT_OWNER_ENV]
  delete next[LAYOUT_OWNER_RESOLVED_ENV]
  return next
}
