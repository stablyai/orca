// Profile environment wrapping must retain the automatic-agent root-directory guard.
import { expect, it } from 'vitest'
import { prepareAgentProfileTerminalCommand } from './terminal-command'
import { createLocalPtyLaunchPlan } from '../providers/local-pty-launch-plan'
import { createPtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'

it.each(['claude', 'codex'] as const)(
  'refuses wrapped %s in root at both launch boundaries',
  (agent) => {
    const home = '/tmp/synthetic-profile'
    const launch = prepareAgentProfileTerminalCommand(
      {
        snapshot: {
          id: 'a',
          name: 'A',
          agent,
          hostId: 'local',
          executable: '/tools/provider',
          binding: { kind: 'external', home },
          resolvedHome: home,
          identity: { kind: 'unverified', reason: 'external' }
        },
        envPatch: { [agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home },
        envToDelete: [],
        release: () => {}
      },
      agent
    )
    expect(launch.command).toContain("'/usr/bin/env'")
    const args = { ...launch, cwd: '/', cols: 80, rows: 24, shellOverride: '/bin/sh' }
    expect(() => createLocalPtyLaunchPlan(args, () => ({}))).toThrow('non-root workspace')
    expect(() => createPtyShellLaunchPlan({ ...args, sessionId: 's' }, { HOME: '/tmp' })).toThrow(
      'non-root workspace'
    )
  }
)
