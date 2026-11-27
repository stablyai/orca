import { describe, expect, it } from 'vitest'
import { createManagedCommandMatcher } from './managed-hook-command-matching'
import { wrapPosixHookCommand } from './posix-hook-command'
import {
  wrapRuntimeHomeHookCommand,
  wrapRuntimeHomePosixHookCommand
} from './runtime-home-hook-command'
import { wrapWindowsBatchHookCommand } from './windows-direct-cmd-hook-command'
import { buildWindowsHookPowerShellCommand, wrapWindowsHookCommand } from './windows-hook-command'
import {
  getWindowsSystem32Path,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'
import { HOOK_PARENT_CAPTURE } from '../scripts/hook-process-capture'
import { buildCodexHookCommand } from '../../../codex/hooks/definitions/codex-hook-command-form'
import {
  buildCodexManagedHook,
  CODEX_EVENTS
} from '../../../codex/hooks/definitions/codex-hook-definition'
import { planRealHomeCodexHookEntries } from '../../../codex/hooks/reconciliation/codex-real-home-hook-entry-plan'
import { getPosixManagedCommand as getCursorPosixManagedCommand } from '../../../cursor/hook-script'
import { getPosixManagedCommand as getCopilotPosixManagedCommand } from '../../../copilot/copilot-managed-hook-definitions'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { quoteStartupArg } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'

describe('createManagedCommandMatcher ownership across Orca hook builders', () => {
  it('matches Codex POSIX and Windows hook commands and keeps real-home planning idempotent', () => {
    const matchesCodex = createManagedCommandMatcher('codex-hook.sh')
    const posixCommand = buildCodexHookCommand(
      '/Users/dev/.orca/agent-hooks/codex-hook.sh',
      'darwin'
    )
    const windowsBare = buildCodexHookCommand(
      'C:\\Users\\dev\\.orca\\agent-hooks\\codex-hook.cmd',
      'win32'
    )
    const windowsSpaced = buildCodexHookCommand(
      'C:\\Users\\Jane & Doe\\.orca\\agent-hooks\\codex-hook.cmd',
      'win32',
      { SystemRoot: 'C:\\Windows' }
    )

    expect(matchesCodex(posixCommand)).toBe(true)
    expect(matchesCodex(windowsBare)).toBe(true)
    expect(matchesCodex(windowsSpaced)).toBe(true)

    const installed = Object.fromEntries(
      CODEX_EVENTS.map((eventName) => [
        eventName,
        [{ hooks: [buildCodexManagedHook(posixCommand, eventName)] }]
      ])
    )
    const settled = planRealHomeCodexHookEntries({
      hooks: installed,
      sourcePath: '/Users/dev/.codex/hooks.json',
      material: { events: CODEX_EVENTS, command: posixCommand },
      isOrcaCommand: matchesCodex,
      convertOlderForms: false
    })
    expect(settled.kind).toBe('settle')
    if (settled.kind === 'settle') {
      expect(settled.changedLabels.size).toBe(0)
    }

    const duplicated = Object.fromEntries(
      CODEX_EVENTS.map((eventName) => [
        eventName,
        [
          { hooks: [buildCodexManagedHook(posixCommand, eventName)] },
          { hooks: [buildCodexManagedHook(posixCommand, eventName)] }
        ]
      ])
    )
    const pruned = planRealHomeCodexHookEntries({
      hooks: duplicated,
      sourcePath: '/Users/dev/.codex/hooks.json',
      material: { events: CODEX_EVENTS, command: posixCommand },
      isOrcaCommand: matchesCodex,
      convertOlderForms: false
    })
    expect(pruned.kind).toBe('prune')
    if (pruned.kind === 'prune') {
      for (const eventName of CODEX_EVENTS) {
        expect(pruned.hooks[eventName]).toHaveLength(1)
      }
    }
  })

  it('matches Cursor POSIX (portable sh -c quoting) and Windows (UTF-8 PowerShell) hook commands', () => {
    const matchesCursor = createManagedCommandMatcher('cursor-hook.sh')
    const posixWrapped = `/bin/sh -c ${quoteStartupArg(
      getCursorPosixManagedCommand(
        '/Users/dev/.orca/agent-hooks/cursor-hook.sh',
        'beforeSubmitPrompt'
      ),
      'posix'
    )}`
    const windowsPs = wrapWindowsPowerShellEncodedCommand(
      `[Console]::InputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::InputEncoding; ${buildWindowsHookPowerShellCommand(
        'C:\\Users\\Jane Doe\\.orca\\agent-hooks\\cursor-hook.cmd',
        { ORCA_CURSOR_HOOK_RESPONSE: '{"continue":true}' },
        { fallbackStdout: '{"continue":true}' }
      )}`
    )

    expect(matchesCursor(posixWrapped)).toBe(true)
    expect(matchesCursor(windowsPs)).toBe(true)
  })

  it('matches Copilot, Kiro, Claude, and Antigravity managed hook commands', () => {
    const matchesCopilot = createManagedCommandMatcher('copilot-hook.sh')
    expect(
      matchesCopilot(
        getCopilotPosixManagedCommand(
          '/Users/dev/.orca/agent-hooks/copilot-hook.sh',
          'SessionStart'
        )
      )
    ).toBe(true)
    expect(
      matchesCopilot(
        `${getWindowsSystem32Path('cmd.exe')} /d /c C:/Users/dev/.orca/agent-hooks/copilot-hook.cmd SessionStart`
      )
    ).toBe(true)
    expect(
      matchesCopilot(
        wrapWindowsHookCommand('C:\\Users\\Jane Doe\\.orca\\agent-hooks\\copilot-hook.cmd', {
          ORCA_COPILOT_HOOK_EVENT: 'SessionStart'
        })
      )
    ).toBe(true)

    const matchesKiro = createManagedCommandMatcher('kiro-hook.sh')
    expect(
      matchesKiro(
        wrapPosixHookCommand(
          '/Users/dev/.orca/agent-hooks/kiro-hook.sh',
          {},
          { exitOutsideOrca: true }
        )
      )
    ).toBe(true)
    expect(
      matchesKiro(
        `if defined ORCA_PANE_KEY ${wrapWindowsBatchHookCommand('C:\\Users\\Jane Doe\\.orca\\agent-hooks\\kiro-hook.cmd')}`
      )
    ).toBe(true)

    const matchesClaude = createManagedCommandMatcher('claude-hook.sh')
    expect(matchesClaude(wrapRuntimeHomeHookCommand('claude-hook'))).toBe(true)
    expect(
      matchesClaude(wrapRuntimeHomeHookCommand('claude-hook', { neutralJsonWhenMissing: true }))
    ).toBe(true)
    expect(matchesClaude(wrapRuntimeHomePosixHookCommand('claude-hook'))).toBe(true)

    const matchesAntigravity = createManagedCommandMatcher('antigravity-hook.sh')
    const agyInner = wrapPosixHookCommand(
      '/Users/dev/.orca/agent-hooks/antigravity-hook.sh',
      { ORCA_ANTIGRAVITY_EVENT: 'pre_tool_use' },
      { fallbackStdout: '{}', stdinMayStayOpen: true }
    )
    expect(
      matchesAntigravity(`/bin/sh -c ${quotePosixShell(`${HOOK_PARENT_CAPTURE}${agyInner}`)}`)
    ).toBe(true)
  })

  it('rejects composite or user-modified commands referencing Orca hook scripts', () => {
    const matchesCodex = createManagedCommandMatcher('codex-hook.sh')
    const matchesCursor = createManagedCommandMatcher('cursor-hook.sh')
    const matchesCopilot = createManagedCommandMatcher('copilot-hook.sh')

    const codexPosix = buildCodexHookCommand('/Users/dev/.orca/agent-hooks/codex-hook.sh', 'darwin')
    expect(matchesCodex(`${codexPosix}; echo user`)).toBe(false)
    expect(
      matchesCodex(
        'if [ -n "${MY_USER_VAR-}" ] && [ -f "/Users/dev/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "/Users/dev/.orca/agent-hooks/codex-hook.sh"; fi'
      )
    ).toBe(false)
    expect(
      matchesCodex(
        'C:\\Windows\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/dev/.orca/agent-hooks/codex-hook.cmd" & echo user'
      )
    ).toBe(false)
    expect(
      matchesCopilot(
        'C:/Windows/System32/cmd.exe /d /c C:/Users/dev/.orca/agent-hooks/copilot-hook.cmd SessionStart & echo user'
      )
    ).toBe(false)
    expect(
      matchesCursor(
        `/bin/sh -c ${quoteStartupArg(
          getCursorPosixManagedCommand('/Users/dev/.orca/agent-hooks/cursor-hook.sh', 'stop'),
          'posix'
        )}; echo user`
      )
    ).toBe(false)
  })
})
