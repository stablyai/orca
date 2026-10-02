import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { describeLaunchHost } from '../../shared/launch-host'
import { planLaunchPrompt } from '../../shared/tui-agent-startup'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'

// The stack QA's WSL workspace: a folder repo added by its distro path (P8-6).
const WSL_REPO = { connectionId: null, path: '\\\\wsl.localhost\\qasfwin\\root\\fixture' }
const P25K = 'QA-STACK P25K one line, inert. '.padEnd(25_600, 'x')

function plan(prompt: string, terminalWindowsShell: string) {
  const platform = getAgentLaunchPlatformForRepo(WSL_REPO)
  return planLaunchPrompt({
    ...resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: { terminalWindowsShell },
      platform,
      isRemote: false
    }),
    prompt,
    host: describeLaunchHost({
      launchPlatform: platform,
      isRemote: false,
      hostPlatform: 'win32',
      paired: false
    }),
    paste: 'when-host-proves-agent'
  })
}

// Why: the pane runs the distro's POSIX shell, so the Windows shell setting must not decide how the
// line is judged or quoted; quoted for cmd, bash ran the pointer's backticked path and lost it.
describe('a launch into a WSL workspace, whatever the Windows shell setting', () => {
  it('is planned for the distro', () => {
    expect(getAgentLaunchPlatformForRepo(WSL_REPO)).toBe('linux')
  })

  it.each(['powershell.exe', 'git-bash', 'cmd.exe'])(
    'stages a 25 KB prompt on a POSIX line under %s',
    (terminalWindowsShell) => {
      const planned = plan(P25K, terminalWindowsShell)
      expect(planned?.carry).toBe('on-line')
      expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toMatch(
        new RegExp(`^claude .* '${P25K}'$`)
      )
    }
  )

  it.each(['powershell.exe', 'cmd.exe'])(
    'keeps $ and backticks literal on the line under %s',
    (terminalWindowsShell) => {
      const prompt = 'print $HOME and `id` as text'
      const planned = plan(prompt, terminalWindowsShell)
      // POSIX single quotes: bash expands neither `$HOME` nor the backticks inside them.
      expect(planned?.carry === 'on-line' && planned.plan.launchCommand).toMatch(
        /^claude .* 'print \$HOME and `id` as text'$/
      )
    }
  )
})

// Why: a pane whose Windows shell is WSL runs the same POSIX shell, staged by the host.
describe('a WSL pane on a Windows workspace', () => {
  it('judges its line by the distro, not by Git Bash', () => {
    const planned = planLaunchPrompt({
      ...resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: { terminalWindowsShell: 'wsl.exe' },
        platform: 'win32',
        isRemote: false
      }),
      prompt: P25K,
      host: describeLaunchHost({
        launchPlatform: 'win32',
        isRemote: false,
        hostPlatform: 'win32',
        paired: false,
        windowsPaneShell: 'wsl.exe'
      }),
      paste: 'when-host-proves-agent'
    })
    expect(planned?.carry).toBe('on-line')
  })
})
