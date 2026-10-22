import { WINDOWS_HOOK_STDIN_DRAIN_LABEL } from './hook-stdin-contract'

// Cursor imports Claude hooks; only its native hook may report its events.
export function buildPosixCursorReplayGuardLines(): string[] {
  return ['if [ -n "$CURSOR_VERSION" ] && [ -n "$CURSOR_PROJECT_DIR" ]; then', '  exit 0', 'fi']
}

export function buildWindowsCursorReplayGuardLines(): string[] {
  return [
    `if not "%CURSOR_VERSION%"=="" if not "%CURSOR_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
  ]
}
