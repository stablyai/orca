import { WINDOWS_HOOK_STDIN_DRAIN_LABEL } from './hook-stdin-contract'

export function buildPosixGrokReplayGuardLines(): string[] {
  return [
    // Imported vendor hooks must not duplicate Grok's native hook event.
    'if [ -n "$GROK_HOOK_EVENT" ]; then',
    '  exit 0',
    'fi'
  ]
}

export function buildWindowsGrokReplayGuardLines(): string[] {
  return [`if not "%GROK_HOOK_EVENT%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`]
}
