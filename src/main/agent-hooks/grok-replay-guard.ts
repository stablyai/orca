import { WINDOWS_HOOK_STDIN_DRAIN_LABEL } from './hook-stdin-contract'

export function buildPosixGrokReplayGuardLines(): string[] {
  return [
    // Why: Grok imports vendor hooks; only its native hook may report the event as Grok.
    'if [ -n "$GROK_HOOK_EVENT" ]; then',
    '  exit 0',
    'fi'
  ]
}

export function buildWindowsGrokReplayGuardLines(): string[] {
  return [`if not "%GROK_HOOK_EVENT%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`]
}
