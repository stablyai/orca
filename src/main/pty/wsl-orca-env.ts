const WSLENV_ENTRY_SEPARATOR = ':'

function parseWslenvEntries(value: string | undefined): string[] {
  return value ? value.split(WSLENV_ENTRY_SEPARATOR).filter(Boolean) : []
}

function hasWslenvVariable(entries: readonly string[], variableName: string): boolean {
  return entries.some((entry) => entry.split('/')[0] === variableName)
}

export function addOrcaWslInteropEnv(env: Record<string, string>): void {
  const entries = parseWslenvEntries(env.WSLENV)
  if (!hasWslenvVariable(entries, 'ORCA_TERMINAL_HANDLE')) {
    // Why: WSL only imports selected Windows env vars. The terminal handle is
    // the trusted orchestration identity, so managed WSL shells must opt it in.
    entries.push('ORCA_TERMINAL_HANDLE/u')
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}
