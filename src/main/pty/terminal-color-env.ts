export function removeInheritedNoColor(env: Record<string, string>): void {
  // Why: Orca can be launched by agent/dev shells that set NO_COLOR=1 for their
  // own logs. A terminal emulator should not inherit that parent-only choice;
  // if the user's login shell exports NO_COLOR, startup files can still set it.
  delete env.NO_COLOR
}
