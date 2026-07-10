export function removeInheritedNoColor(env: Record<string, string>): void {
  // Why: Orca can be launched by agent/dev shells that disable color for their
  // own logs. A terminal emulator should not inherit that parent-only choice;
  // if the user's login shell exports these, startup files can still set them.
  delete env.NO_COLOR
  if (env.FORCE_COLOR === '0') {
    delete env.FORCE_COLOR
  }
  if (env.CLICOLOR === '0') {
    delete env.CLICOLOR
  }
}
