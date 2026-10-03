export function buildPosixGrokReplayGuardLines(): string[] {
  return [
    // Why: Grok imports vendor hooks; only its native hook may report the event as Grok.
    'if [ -n "$GROK_HOOK_EVENT" ]; then',
    '  exit 0',
    'fi'
  ]
}

export function buildWindowsGrokReplayGuardLines(): string[] {
  // Why (#11549): exit without owning stdin. Jumping to the more.com drain parks the hook
  // forever when the caller abandons the pipe, and the payload is discarded on this path
  // anyway — the same rule buildWindowsHookEnvironmentGuardLines() already follows.
  return ['if not "%GROK_HOOK_EVENT%"=="" exit /b 0']
}
