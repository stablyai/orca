import { describe, expect, it } from 'vitest'
import { resolveCodexStructuredAppServerArgs } from './codex-structured-app-server-args'
import { YOLO_TUI_AGENT_ARGS } from '../../shared/tui-agent-permissions'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'

/** Asserts the configured CLI permission flags become explicit app-server config assignments. */
function expectPermissionConfig(
  configured: string,
  shell: AgentStartupShell,
  approvalPolicy: string,
  sandboxMode: string
): void {
  expect(resolveCodexStructuredAppServerArgs(configured, shell)).toEqual([
    '-c',
    `approval_policy="${approvalPolicy}"`,
    '-c',
    `sandbox_mode="${sandboxMode}"`
  ])
}

describe('structured Codex app-server arguments', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    'translates the configured YOLO default into app-server permissions on %s',
    (shell) =>
      expectPermissionConfig(YOLO_TUI_AGENT_ARGS.codex!, shell, 'never', 'danger-full-access')
  )

  it.each([
    '-a on-request -s workspace-write',
    '--ask-for-approval=on-request --sandbox=workspace-write'
  ])('preserves explicit restricted permissions: %s', (configured) =>
    expectPermissionConfig(configured, 'posix', 'on-request', 'workspace-write')
  )

  it('does not grant bypass permissions when YOLO is disabled', () =>
    expect(resolveCodexStructuredAppServerArgs('', 'posix')).toEqual([]))

  it('keeps configuration flags and converts effort to the app-server config contract', () => {
    expect(
      resolveCodexStructuredAppServerArgs(
        '--profile review -c approval_policy=never --model gpt-5.6 --effort high --search',
        'posix'
      )
    ).toEqual([
      '--profile',
      'review',
      '-c',
      'approval_policy=never',
      '--model',
      'gpt-5.6',
      '-c',
      'model_reasoning_effort=high',
      '--search'
    ])
  })

  it.each(['--no-alt-screen', '--remote ws://host', '-C /tmp/elsewhere', 'resume thread-1'])(
    'reports an incompatible configured argument instead of dropping %s',
    (configured) => {
      expect(() => resolveCodexStructuredAppServerArgs(configured, 'posix')).toThrow(
        /cannot apply the configured CLI arguments.*Settings or use terminal view/
      )
    }
  )
})
