export function buildPosixGrokReplayGuardLines(): string[] {
  return [
    // Imported vendor hooks must not duplicate Grok's native hook event.
    'if [ -n "$GROK_HOOK_EVENT" ]; then',
    '  exit 0',
    'fi'
  ]
}

export function buildWindowsGrokReplayGuardLines(): string[] {
  // Exit without owning stdin: more.com parks forever if the caller holds the pipe open (#24907).
  return ['if not "%GROK_HOOK_EVENT%"=="" exit /b 0']
}
