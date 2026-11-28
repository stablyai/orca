import { LAYOUT_OWNER_ENV_KEYS } from '../../../shared/workspace-layout/layout-owner-startup'

export function stripInheritedBuildModeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Orca inherits its own build mode; leaking it changes user next/Vitest behavior. Explicit spawn env and rc files still win.
  const next = { ...env }
  delete next.NODE_ENV
  for (const key of LAYOUT_OWNER_ENV_KEYS) {
    delete next[key]
  }
  return next
}
