export function removeInheritedNoColor(env: Record<string, string>): void {
  // Parent log settings must not disable terminal color; user startup files may still override.
  delete env.NO_COLOR
  if (env.FORCE_COLOR === '0') {
    delete env.FORCE_COLOR
  }
  if (env.CLICOLOR === '0') {
    delete env.CLICOLOR
  }
}
