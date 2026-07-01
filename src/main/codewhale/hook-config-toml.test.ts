import { describe, expect, it } from 'vitest'
import {
  applyManagedCodeWhaleHooks,
  buildManagedCodeWhaleHooksBlock,
  CODEWHALE_HOOK_EVENTS,
  readManagedCodeWhaleHookEvents,
  removeManagedCodeWhaleHooks
} from './hook-config-toml'

describe('CodeWhale managed hook TOML block', () => {
  it('writes managed CodeWhale hook entries using the hooks.hooks schema', () => {
    const block = buildManagedCodeWhaleHooksBlock((event) => `run-orca ${event}`)

    expect(block).not.toContain('[hooks]\n')
    expect(block).not.toContain('enabled = true')
    for (const event of CODEWHALE_HOOK_EVENTS) {
      expect(block).toContain(`event = "${event}"`)
      expect(block).toContain(`name = "orca-status-${event}"`)
    }
    expect(block.match(/\[\[hooks\.hooks\]\]/g)?.length).toBe(CODEWHALE_HOOK_EVENTS.length)
    expect(block).toContain('timeout_secs = 10')
    expect(block.match(/background = false/g)?.length).toBe(CODEWHALE_HOOK_EVENTS.length - 1)
    expect(block.match(/background = true/g)?.length).toBe(1)
    expect(block).toContain('continue_on_error = true')
  })

  it('preserves user config, avoids duplicate managed blocks, and removes only Orca hooks', () => {
    const userConfig =
      '[hooks]\nenabled = true\n\n[[hooks.hooks]]\nevent = "shell_env"\ncommand = "echo mine"\n'
    const installed = applyManagedCodeWhaleHooks(userConfig, (event) => `orca-status ${event}`)
    const reinstalled = applyManagedCodeWhaleHooks(installed, (event) => `orca-status ${event}`)

    expect(reinstalled).toContain('command = "echo mine"')
    expect((reinstalled.match(/orca-managed-codewhale-hooks/g) ?? []).length).toBe(2)

    const removed = removeManagedCodeWhaleHooks(reinstalled)
    expect(removed.changed).toBe(true)
    expect(removed.text).toBe(userConfig)
  })

  it('sweeps stale managed CodeWhale hook tables outside the current block', () => {
    const userConfig = [
      '[[hooks.hooks]]',
      'event = "message_submit"',
      'command = "sh /home/dev/.orca/agent-hooks/codewhale-hook.sh"',
      '',
      '[[hooks.hooks]]',
      'event = "shell_env"',
      'command = "echo mine"',
      ''
    ].join('\n')

    const installed = applyManagedCodeWhaleHooks(
      userConfig,
      (event) => `orca-status ${event}`,
      (command) => Boolean(command?.includes('codewhale-hook.sh'))
    )

    expect(installed).not.toContain('event = "message_submit"')
    expect(installed).toContain('event = "shell_env"')
    expect(installed).toContain('command = "echo mine"')
    for (const event of CODEWHALE_HOOK_EVENTS) {
      expect(installed).toContain(`event = "${event}"`)
    }
  })

  it('reads managed events from escaped TOML command strings', () => {
    const installed = applyManagedCodeWhaleHooks(
      '',
      (event) =>
        `set "ORCA_CODEWHALE_HOOK_EVENT=${event}" && "C:\\Users\\dev\\.orca\\agent-hooks\\codewhale-hook.cmd"`
    )
    const present = readManagedCodeWhaleHookEvents(installed, (command) =>
      Boolean(command?.includes('agent-hooks\\codewhale-hook.cmd'))
    )

    expect([...present].sort()).toEqual([...CODEWHALE_HOOK_EVENTS].sort())
  })

  it('keeps doubled backslashes intact before TOML control escapes', () => {
    const installed = applyManagedCodeWhaleHooks(
      '',
      (event) =>
        `set "ORCA_CODEWHALE_HOOK_EVENT=${event}" && "C:\\Users\\tom\\.orca\\agent-hooks\\codewhale-hook.cmd"`
    )
    const present = readManagedCodeWhaleHookEvents(installed, (command) =>
      Boolean(command?.includes('C:\\Users\\tom\\.orca\\agent-hooks\\codewhale-hook.cmd'))
    )

    expect([...present].sort()).toEqual([...CODEWHALE_HOOK_EVENTS].sort())
  })
})
