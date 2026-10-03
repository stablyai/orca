import { describe, expect, it } from 'vitest'
import { CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  codexHookSessionFlagDefines,
  type CodexHookSessionTrust
} from './codex-hook-session-flags'
import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'

function trustFor(prefix: string): CodexHookSessionTrust {
  return Object.fromEntries(
    CODEX_EVENTS.map((eventName) => {
      const label = CODEX_EVENT_LABEL[eventName]
      return [label, { key: `${prefix}:${label}:0:0`, trustedHash: `sha256:${label}` }]
    })
  )
}

describe('buildCodexHookSessionFlag', () => {
  it('defines every managed event and approves each with its reported hash (POSIX)', () => {
    const flag = buildCodexHookSessionFlag(
      ': form; /bin/sh "$HOME/x"',
      trustFor('/<session-flags>/config.toml'),
      'darwin'
    )
    expect(flag).not.toBeNull()
    expect(flag!.startsWith('hooks={')).toBe(true)
    for (const eventName of CODEX_EVENTS) {
      const label = CODEX_EVENT_LABEL[eventName]
      // Why per event: Codex hashes its own normalization, which caps Interrupt at 3 s.
      const timeout = eventName === 'Interrupt' ? 3 : 10
      expect(flag).toContain(
        `${eventName}=[{hooks=[{type="command",command=": form; /bin/sh \\"$HOME/x\\"",timeout=${timeout}}]}]`
      )
      expect(flag).toContain(
        `"/<session-flags>/config.toml:${label}:0:0"={trusted_hash="sha256:${label}",enabled=true}`
      )
    }
  })

  it('spells Windows values with single quotes and spaces, and no double quote or percent', () => {
    const flag = buildCodexHookSessionFlag(
      'C:/Users/me/.orca/agent-hooks/codex-hook.cmd',
      trustFor('C:\\<session-flags>\\config.toml'),
      'win32'
    )
    expect(flag).not.toBeNull()
    expect(flag).toContain(' ')
    expect(flag).not.toMatch(/["%]/)
    expect(flag).toContain(
      "'C:\\<session-flags>\\config.toml:stop:0:0' = { trusted_hash = 'sha256:stop', enabled = true }"
    )
  })

  it('carries nothing on Windows when the command needs a quote the shells would mangle', () => {
    const cmdSpelling =
      'C:\\Windows\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/a b/codex-hook.cmd"'
    expect(
      buildCodexHookSessionFlag(cmdSpelling, trustFor('C:\\<session-flags>\\config.toml'), 'win32')
    ).toBeNull()
    expect(buildCodexHookDefinitionFlag(cmdSpelling, 'win32')).toBeNull()
  })

  it('carries nothing when any event lacks its approval, since that event would open a review', () => {
    const partial = { ...trustFor('/<session-flags>/config.toml') }
    delete partial[CODEX_EVENT_LABEL.Stop]
    expect(buildCodexHookSessionFlag('x', partial, 'linux')).toBeNull()
  })

  it('still carries the hook when a Codex that predates Interrupt approved only the others', () => {
    const withoutInterrupt = { ...trustFor('/<session-flags>/config.toml') }
    delete withoutInterrupt[CODEX_EVENT_LABEL.Interrupt]

    const flag = buildCodexHookSessionFlag('x', withoutInterrupt, 'linux')

    expect(flag).toContain('Interrupt=[{hooks=[{type="command",command="x",timeout=3}]}]')
    expect(flag).not.toContain(':interrupt:0:0')
    expect(codexHookSessionFlagDefines(flag!, 'x', 'linux')).toBe(true)
  })

  it('defines the hook without any approval for the hash lookup', () => {
    const flag = buildCodexHookDefinitionFlag('x', 'linux')
    expect(flag).toContain('Stop=[{hooks=[{type="command",command="x",timeout=10}]}]')
    expect(flag).not.toContain('state')
  })

  it('carries nothing on Windows for a non-ASCII path, which cmd.exe reads in its code page', () => {
    const command = 'C:/Users/José/.orca/agent-hooks/codex-hook.cmd'
    expect(buildCodexHookDefinitionFlag(command, 'win32')).toBeNull()
    expect(buildCodexHookDefinitionFlag(command, 'linux')).not.toBeNull()
  })
})

describe('codexHookSessionFlagDefines', () => {
  const trust = trustFor('/<session-flags>/config.toml')

  it.each(['linux', 'win32'] as const)(
    'accepts a flag built from the same command (%s)',
    (platform) => {
      const flag = buildCodexHookSessionFlag('C:/x/codex-hook.cmd', trust, platform)!
      expect(codexHookSessionFlagDefines(flag, 'C:/x/codex-hook.cmd', platform)).toBe(true)
    }
  )

  it('rejects a flag for another command, whose approval hashes other bytes', () => {
    const flag = buildCodexHookSessionFlag('/a/codex-hook.sh', trust, 'linux')!
    expect(codexHookSessionFlagDefines(flag, '/b/codex-hook.sh', 'linux')).toBe(false)
  })

  it('rejects an entry from before every event carried enabled = true', () => {
    const flag = buildCodexHookSessionFlag('/a/codex-hook.sh', trust, 'linux')!.replaceAll(
      ',enabled=true}',
      '}'
    )
    expect(codexHookSessionFlagDefines(flag, '/a/codex-hook.sh', 'linux')).toBe(false)
  })

  it('rejects a flag whose hook timeout differs, since Codex hashes the timeout too', () => {
    const flag = buildCodexHookSessionFlag('/a/codex-hook.sh', trust, 'linux')!.replaceAll(
      `timeout=${MANAGED_HOOK_TIMEOUT_SECONDS}`,
      `timeout=${MANAGED_HOOK_TIMEOUT_SECONDS + 5}`
    )
    expect(codexHookSessionFlagDefines(flag, '/a/codex-hook.sh', 'linux')).toBe(false)
  })
})
