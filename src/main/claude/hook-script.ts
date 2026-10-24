import { buildHookProcessCapture } from '../agent-hooks/hook-process-capture'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installer-utils'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildPosixCursorReplayGuardLines,
  buildWindowsCursorReplayGuardLines
} from '../agent-hooks/cursor-replay-guard'
import {
  buildPosixGrokReplayGuardLines,
  buildWindowsGrokReplayGuardLines
} from '../agent-hooks/grok-replay-guard'
import {
  WINDOWS_HOOK_STDIN_DRAIN_LABEL,
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'

// Daemon workers inherit stale pane keys; exit before draining their potentially abandoned stdin.
export const WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD = 'if not "%CLAUDE_JOB_DIR%"=="" exit /b 0'

export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: {
    source?: AgentHookSource
    skipWhenDevinImportsClaude?: boolean
    skipWhenGrokImportsClaude?: boolean
    skipWhenCursorImportsClaude?: boolean
  } = {}
): string {
  const source = options.source ?? 'claude'
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Permission hooks fail closed on empty stdout, including skip paths.
      'echo {}',
      // Refresh endpoint coordinates for PTYs surviving an Orca restart.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Guard abandoned stdin before any skip path can drain it.
      ...buildWindowsHookEnvironmentGuardLines(),
      WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
      ...(options.skipWhenGrokImportsClaude ? buildWindowsGrokReplayGuardLines() : []),
      ...(options.skipWhenCursorImportsClaude ? buildWindowsCursorReplayGuardLines() : []),
      ...(options.skipWhenDevinImportsClaude
        ? [
            // Devin imports Claude hooks; skip duplicate posts to preserve Devin attribution.
            `if not "%DEVIN_PROJECT_DIR%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`
          ]
        : []),
      // Avoid a PowerShell startup per hook.
      buildWindowsAgentHookCurlPostCommand(source),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Permission hooks fail closed on empty stdout, including skip paths.
    'printf "{}\\n"',
    ...buildPosixHookPayloadCapture(),
    ...(options.skipWhenGrokImportsClaude ? buildPosixGrokReplayGuardLines() : []),
    ...(options.skipWhenCursorImportsClaude ? buildPosixCursorReplayGuardLines() : []),
    ...buildPosixHookSpoolLines(source),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Devin imports Claude hooks; skip duplicate posts to preserve Devin attribution.
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          '  exit 0',
          'fi'
        ]
      : []),
    // Daemon workers inherit pane keys that do not identify their own sessions.
    'if [ -n "$CLAUDE_JOB_DIR" ]; then',
    '  exit 0',
    'fi',
    ...(source === 'claude' ? buildHookProcessCapture() : []),
    // Surviving PTYs need fresh endpoint coordinates; suppress errors and survive outer set -e.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  unset ORCA_AGENT_HOOK_TRANSPORT',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Keep hook JSON off argv and avoid URL-encoded paths that trigger IDS rules.
    ...buildPosixAgentHookPostCommand(source).map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}
