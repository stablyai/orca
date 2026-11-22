export function stripInheritedBuildModeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Orca inherits its own build mode; leaking it changes user next/Vitest behavior. Explicit spawn env and rc files still win.
  const next = { ...env }
  delete next.NODE_ENV
  return next
}
