import { describe, expect, it } from 'vitest'
import {
  applyManagedVibeHooks,
  buildManagedVibeHooksBlock,
  removeManagedVibeHooks,
  readManagedVibeHookTypes,
  VIBE_HOOK_TYPES
} from './hook-config-toml'

const COMMAND =
  "if [ -x '/home/u/.orca/agent-hooks/mistral-vibe-hook.sh' ]; then /bin/sh '/home/u/.orca/agent-hooks/mistral-vibe-hook.sh'; fi"
const isManaged = (command: string | undefined): boolean =>
  typeof command === 'string' && command.includes('agent-hooks/mistral-vibe-hook.sh')

describe('vibe managed hooks TOML block', () => {
  it('installs every managed type with match on tool hooks, none on post_agent', () => {
    const block = buildManagedVibeHooksBlock(COMMAND)
    for (const type of VIBE_HOOK_TYPES) {
      expect(block).toContain(`type = "${type}"`)
    }
    // Tool hooks get match = "*"; post_agent does not (Vibe rejects match on post_agent).
    expect(block).toMatch(/\[\[hooks\]\][\s\S]*?type = "pre_tool"[\s\S]*?match = "\*"/)
    expect(block).toMatch(/\[\[hooks\]\][\s\S]*?type = "post_tool"[\s\S]*?match = "\*"/)
    const postAgentChunk = block.split('type = "post_agent"')[1]
    expect(postAgentChunk).not.toContain('match =')
    expect(readManagedVibeHookTypes(applyManagedVibeHooks('', COMMAND), isManaged)).toEqual(
      new Set(VIBE_HOOK_TYPES)
    )
  })

  it('preserves existing user config above the managed block', () => {
    const userConfig = [
      'default_agent = "accept-edits"',
      '',
      '[[hooks]]',
      'name = "user-guard"',
      'type = "pre_tool"',
      'match = "bash"',
      'command = "uv run python /path/to/guard"',
      ''
    ].join('\n')

    const next = applyManagedVibeHooks(userConfig, COMMAND)
    expect(next).toContain('default_agent = "accept-edits"')
    // The user's own hook survives untouched.
    expect(next).toContain('name = "user-guard"')
    expect(next).toContain('command = "uv run python /path/to/guard"')
    expect(readManagedVibeHookTypes(next, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
  })

  it('is idempotent — reinstalling does not duplicate the block', () => {
    const once = applyManagedVibeHooks('default_agent = "x"\n', COMMAND)
    const twice = applyManagedVibeHooks(once, COMMAND)
    expect(twice).toBe(once)
    expect((twice.match(/orca-managed-vibe-hooks \(/g) ?? []).length).toBe(1)
  })

  it('removes the managed block and restores the user config', () => {
    const userConfig = 'default_agent = "accept-edits"\n'
    const installed = applyManagedVibeHooks(userConfig, COMMAND)
    const { text, changed } = removeManagedVibeHooks(installed)
    expect(changed).toBe(true)
    expect(text).toBe(userConfig)
    expect(readManagedVibeHookTypes(text, isManaged).size).toBe(0)
  })

  it('reports no change when removing from a config without the managed block', () => {
    const { text, changed } = removeManagedVibeHooks('default_agent = "x"\n')
    expect(changed).toBe(false)
    expect(text).toBe('default_agent = "x"\n')
  })

  it('is stable across repeated calls (no stateful global-regex lastIndex drift)', () => {
    const installed = applyManagedVibeHooks('default_agent = "x"\n', COMMAND)
    expect(removeManagedVibeHooks(installed).changed).toBe(true)
    expect(removeManagedVibeHooks(installed).changed).toBe(true)
    expect(removeManagedVibeHooks('default_agent = "x"\n').changed).toBe(false)
    expect(readManagedVibeHookTypes(installed, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
    expect(readManagedVibeHookTypes(installed, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
  })

  it('recovers when a hand-edit deletes only the trailing end marker', () => {
    const installed = applyManagedVibeHooks('default_agent = "x"\n', COMMAND)
    const orphaned = installed.replace(/\n# <<< orca-managed-vibe-hooks <<<\n?/, '\n')
    expect(orphaned).not.toContain('<<<')
    expect(readManagedVibeHookTypes(orphaned, isManaged)).toEqual(new Set(VIBE_HOOK_TYPES))
    expect(removeManagedVibeHooks(orphaned)).toEqual({
      text: 'default_agent = "x"\n',
      changed: true
    })
    const reinstalled = applyManagedVibeHooks(orphaned, COMMAND)
    expect((reinstalled.match(/orca-managed-vibe-hooks \(/g) ?? []).length).toBe(1)
  })
})
