import { describe, expect, it, vi } from 'vitest'
import { parse } from 'smol-toml'
import {
  readHookTrustEntriesFromContent,
  removeHookTrustEntriesFromContent,
  upsertHookTrustEntriesInContent,
  upsertProjectTrustLevelInContent,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  CodexConfigTomlEditRefusedError,
  refuseUnreadableCodexConfigResult,
  reportCodexConfigTomlEditRefusal,
  reportCodexTrustWriteRefusals
} from './codex-config-toml-checked-edit'
import { getTomlTable, readTomlValueAtPath } from './codex-config-toml-document'
import { setHookTrustEnabledContent } from './config-toml-hook-trust-edit'
import { repairOrcaCodexConfigDuplicates } from './codex-config-toml-repair'
import { prepareSystemConfigForFreshRuntimeMirror } from './codex-config-mirror'
import { getProjectTrustLevel, getTomlSections } from './config-toml-runtime-owned-sections'

const trust = (content: string, path = '/work/repo', level: 'trusted' | 'untrusted' = 'trusted') =>
  upsertProjectTrustLevelInContent(content, path, level, { alreadyCanonical: true })

function projectsOf(content: string): Record<string, unknown> {
  const parsed = parse(content, { integersAsBigInt: 'asNeeded' })
  return getTomlTable(parsed.projects) ?? {}
}

describe('project trust edits find the existing table in any spelling (#22592)', () => {
  it.each([
    ['bare projects, basic path', '[projects."/work/repo"]'],
    ['quoted projects (Codex desktop form)', '["projects"."/work/repo"]'],
    ['literal-quoted segments', "['projects'.'/work/repo']"],
    ['spaced dots', '[ projects . "/work/repo" ]'],
    ['trailing comment', '[projects."/work/repo"] # added by codex']
  ])('%s', (_name, header) => {
    const existing = `model = "gpt-5"\n\n${header}\ntrust_level = "untrusted"\nsandbox = "workspace-write"\n`
    const updated = trust(existing)

    expect(updated).toBe(existing.replace('"untrusted"', '"trusted"'))
    expect(projectsOf(updated)).toEqual({
      '/work/repo': { trust_level: 'trusted', sandbox: 'workspace-write' }
    })
  })

  it('rewrites a quoted "trust_level" key in place instead of adding a second one', () => {
    const existing = '[projects."/work/repo"]\n"trust_level" = "untrusted" # mine\n'
    expect(trust(existing)).toBe('[projects."/work/repo"]\ntrust_level = "trusted" # mine\n')
  })

  it('finds an escaped-quote path', () => {
    const existing = '["projects"."/work/a \\"b\\""]\ntrust_level = "untrusted"\n'
    const updated = trust(existing, '/work/a "b"')
    expect(Object.keys(projectsOf(updated))).toEqual(['/work/a "b"'])
  })

  it('leaves an inline projects table that already trusts the folder untouched', () => {
    const existing = '[projects]\n"/work/repo" = { trust_level = "trusted" }\n'
    expect(trust(existing)).toBe(existing)
  })

  it('refuses to append a second definition beside an inline project table', () => {
    const existing = '[projects]\n"/work/repo" = { trust_level = "untrusted" }\n'
    expect(() => trust(existing)).toThrow(CodexConfigTomlEditRefusedError)
  })

  it('edits a dotted trust_level key where it is', () => {
    const existing = '# top\nprojects."/work/repo".trust_level = "untrusted"\nmodel = "o3"\n'
    expect(trust(existing)).toBe(
      '# top\nprojects."/work/repo".trust_level = "trusted"\nmodel = "o3"\n'
    )
  })

  it('adds trust as one more dotted key to a project defined by dotted keys', () => {
    const existing = '[projects]\n"/work/repo".sandbox = "read-only"\n'
    const updated = trust(existing)
    expect(updated).toBe(
      '[projects]\n"/work/repo".sandbox = "read-only"\n"/work/repo".trust_level = "trusted"\n'
    )
  })

  it('keeps CRLF, drops only the BOM, and preserves comments', () => {
    const existing = '﻿# keep me\r\n["projects"."/work/repo"]\r\n# and me\r\nmodel = "o3"\r\n'
    const updated = trust(existing)
    expect(updated).toBe(
      '# keep me\r\n["projects"."/work/repo"]\r\ntrust_level = "trusted"\r\n# and me\r\nmodel = "o3"\r\n'
    )
  })

  it('refuses to edit a file that is invalid for reasons Orca did not cause', () => {
    const existing = '[mcp_servers.a]\ncommand = "x"\n[mcp_servers.a]\ncommand = "y"\n'
    const error = (() => {
      try {
        trust(existing)
      } catch (caught) {
        return caught
      }
      return null
    })()
    expect(error).toBeInstanceOf(CodexConfigTomlEditRefusedError)
    expect(error).toMatchObject({ reason: 'input-invalid', line: 3 })
  })

  it('refuses an edit whose result would not parse', () => {
    // An inline root `projects` table cannot be extended with a header.
    const existing = 'projects = { "/other" = { trust_level = "trusted" } }\n'
    expect(() => trust(existing)).toThrow(/would have produced invalid TOML/)
  })
})

describe('repair of duplicates earlier Orca builds wrote (#22592)', () => {
  it('drops Orca’s appended bare table after Codex’s quoted one', () => {
    const broken = [
      '["projects"."/work/repo"]',
      'trust_level = "trusted"',
      '',
      '[projects."/work/repo"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')
    expect(repairOrcaCodexConfigDuplicates(broken)).toBe(
      '["projects"."/work/repo"]\ntrust_level = "trusted"\n'
    )
    expect(trust(broken)).toBe('["projects"."/work/repo"]\ntrust_level = "trusted"\n')
  })

  it('keeps the user’s first answer when Orca appended a different one', () => {
    const broken =
      '["projects"."/w"]\ntrust_level = "untrusted"\n[projects."/w"]\ntrust_level = "trusted"\n'
    expect(projectsOf(repairOrcaCodexConfigDuplicates(broken))).toEqual({
      '/w': { trust_level: 'untrusted' }
    })
  })

  it('keeps the user’s table even when Orca’s copy held a trust line it lacks', () => {
    const broken = '["projects"."/w"]\nmodel = "o3"\n\n[projects."/w"]\ntrust_level = "trusted"\n'
    expect(projectsOf(repairOrcaCodexConfigDuplicates(broken))).toEqual({ '/w': { model: 'o3' } })
    expect(projectsOf(trust(broken, '/w'))).toEqual({
      '/w': { trust_level: 'trusted', model: 'o3' }
    })
  })

  it('drops the bare trust_level Orca inserted beside a quoted one', () => {
    const broken = '[projects."/w"]\ntrust_level = "trusted"\n"trust_level" = "untrusted"\n'
    expect(repairOrcaCodexConfigDuplicates(broken)).toBe(
      '[projects."/w"]\n"trust_level" = "untrusted"\n'
    )
  })

  it('drops a second, empty [hooks.state] header but keeps its comment', () => {
    const broken =
      '[hooks.state]\n\n[hooks.state."k:stop:0:0"]\nenabled = true\n[hooks.state]\n# note\n'
    const repaired = repairOrcaCodexConfigDuplicates(broken)
    expect(repaired).toBe('[hooks.state]\n\n[hooks.state."k:stop:0:0"]\nenabled = true\n# note\n')
    expect(() => parse(repaired)).not.toThrow()
  })

  it('handles the wrong-order sed workaround (two identical bare headers)', () => {
    const broken =
      '[projects."/w"]\ntrust_level = "trusted"\nmodel = "o3"\n\n[projects."/w"]\ntrust_level = "trusted"\n'
    expect(projectsOf(repairOrcaCodexConfigDuplicates(broken))).toEqual({
      '/w': { trust_level: 'trusted', model: 'o3' }
    })
  })

  it('never deletes a duplicate table that carries the user’s own values', () => {
    const broken = '[projects."/w"]\ntrust_level = "trusted"\n[projects."/w"]\nmodel = "o3"\n'
    expect(repairOrcaCodexConfigDuplicates(broken)).toBe(broken)
    expect(() => trust(broken, '/w')).toThrow(CodexConfigTomlEditRefusedError)
  })
})

const hookEntry = (overrides: Partial<CodexTrustEntry> = {}): CodexTrustEntry => ({
  sourcePath: '/home/u/.codex/hooks.json',
  eventLabel: 'stop',
  groupIndex: 0,
  handlerIndex: 0,
  command: '/bin/sh /home/u/.orca/agent-hooks/codex-hook.sh',
  trustedHash: 'sha256:new',
  ...overrides
})

describe('hooks.state edits and reads by decoded key (#22592)', () => {
  const key = '/home/u/.codex/hooks.json:stop:0:0'

  it('replaces a quoted-segment hooks.state table instead of appending a duplicate', () => {
    const existing = `model = "o3"\n\n["hooks"."state"."${key}"]\ntrusted_hash = "sha256:old"\n`
    const updated = upsertHookTrustEntriesInContent(existing, [hookEntry()])
    const state = readTomlValueAtPath(parse(updated), ['hooks', 'state'])
    expect(state).toEqual({ [key]: { enabled: true, trusted_hash: 'sha256:new' } })
    expect(updated.startsWith('model = "o3"\n')).toBe(true)
  })

  it('reads a literal-quoted enabled key and an inline hooks.state entry', () => {
    const content = `[hooks.state]\n"${key}" = { trusted_hash = "sha256:h", 'enabled' = false }\n`
    expect(readHookTrustEntriesFromContent(content).get(key)).toEqual({
      trustedHash: 'sha256:h',
      enabled: false
    })
  })

  it('removes a quoted-segment hooks.state table', () => {
    const existing = `["hooks"."state"."${key}"]\ntrusted_hash = "sha256:old"\n\n[tui]\ntheme = "dark"\n`
    expect(parse(removeHookTrustEntriesFromContent(existing, [key]))).toEqual({
      tui: { theme: 'dark' }
    })
  })
})

describe('the managed-home mirror sees one identity per table (#22592 layer 3)', () => {
  it('keeps one project table when ~/.codex has both spellings', () => {
    const system = [
      '["projects"."/w"]',
      'trust_level = "trusted"',
      '',
      '[projects."/w"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state]',
      '[hooks.state]',
      ''
    ].join('\n')
    const mirrored = prepareSystemConfigForFreshRuntimeMirror(system, '/home/u/.codex')
    expect(() => parse(mirrored)).not.toThrow()
  })

  it('reads a quoted trust_level from a section block', () => {
    const [section] = getTomlSections('["projects"."/w"]\n"trust_level" = \'untrusted\'\n')
    expect(getProjectTrustLevel(section!.block)).toBe('untrusted')
  })
})

describe('review follow-ups for the checked writer', () => {
  it('never treats the same sub-table under two array-of-tables elements as a duplicate', () => {
    const content = [
      '["projects"."/w"]',
      'trust_level = "trusted"',
      '[projects."/w"]',
      'trust_level = "trusted"',
      '[[s]]',
      '[s.o]',
      'x = 1',
      '[[s]]',
      '[s.o]',
      'x = 1',
      ''
    ].join('\n')
    const repaired = repairOrcaCodexConfigDuplicates(content)
    expect(parse(repaired)).toEqual({
      projects: { '/w': { trust_level: 'trusted' } },
      s: [{ o: { x: 1 } }, { o: { x: 1 } }]
    })
  })

  it('keeps the user’s empty table over Orca’s copy directly below it', () => {
    const broken = '["projects"."/w"]\n[projects."/w"]\ntrust_level = "trusted"\n'
    expect(repairOrcaCodexConfigDuplicates(broken)).toBe('["projects"."/w"]\n')
    expect(trust(broken, '/w')).toBe('["projects"."/w"]\ntrust_level = "trusted"\n')
  })

  it('edits a file holding integers past 2^53, which Codex reads as 64-bit', () => {
    const existing = 'max_bytes = 9007199254740993\n'
    const updated = trust(existing)
    expect(updated.startsWith(existing)).toBe(true)
    expect(projectsOf(updated)).toEqual({ '/work/repo': { trust_level: 'trusted' } })
  })

  it('keeps a comment that sits above the next table when replacing or removing a hook block', () => {
    const key = '/home/u/.codex/hooks.json:stop:0:0'
    const existing = `[hooks.state."${key}"]\ntrusted_hash = "sha256:old"\n\n# my servers\n[mcp_servers.z]\ncommand = "z"\n`
    expect(upsertHookTrustEntriesInContent(existing, [hookEntry()])).toContain(
      '# my servers\n[mcp_servers.z]'
    )
    expect(removeHookTrustEntriesFromContent(existing, [key])).toBe(
      '# my servers\n[mcp_servers.z]\ncommand = "z"\n'
    )
  })

  it('inserts `enabled = false` with the file\u2019s own CRLF line ending', () => {
    const key = '/home/u/.codex/hooks.json:stop:0:0'
    const existing = `model = "o3"\r\n[hooks.state."${key}"]\r\ntrusted_hash = "h"\r\n`
    expect(setHookTrustEnabledContent(existing, [{ key, enabled: false }])).toBe(
      `model = "o3"\r\n[hooks.state."${key}"]\r\nenabled = false\r\ntrusted_hash = "h"\r\n`
    )
  })

  it('checks repair removals against the file without Orca\u2019s blocks when the repair alone does not parse', () => {
    const key = '/home/u/.codex/hooks.json:stop:0:0'
    const block = (hash: string) => `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`
    const broken = `model = "o3"\n${block('a')}${block('a')}${block('b')}`
    expect(parse(upsertHookTrustEntriesInContent(broken, [hookEntry()]))).toEqual({
      model: 'o3',
      hooks: { state: { [key]: { enabled: true, trusted_hash: 'sha256:new' } } }
    })
  })

  it('refuses to collapse owned duplicates when something else in the file is also broken', () => {
    const key = '/home/u/.codex/hooks.json:stop:0:0'
    const broken = [
      `[hooks.state."${key}"]`,
      'trusted_hash = "a"',
      `[hooks.state."${key}"]`,
      'trusted_hash = "b"',
      '[mcp_servers.a]',
      'command = "x"',
      '[mcp_servers.a]',
      'command = "y"',
      ''
    ].join('\n')
    expect(() => upsertHookTrustEntriesInContent(broken, [hookEntry()])).toThrow(
      CodexConfigTomlEditRefusedError
    )
    const ownedOnly = broken.split('[mcp_servers.a]')[0]!
    expect(() => parse(upsertHookTrustEntriesInContent(ownedOnly, [hookEntry()]))).not.toThrow()
  })
})

describe('refused Codex config writes', () => {
  it('logs each refusal once, including inside an AggregateError, and returns other failures', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const refusal = new CodexConfigTomlEditRefusedError({
        reason: 'input-invalid',
        detail: 'the file is not valid TOML',
        configPath: '/tmp/report-once-probe/config.toml'
      })
      const other = new Error('EACCES')
      expect(
        reportCodexTrustWriteRefusals(new AggregateError([refusal, other], 'trust write failed'))
      ).toEqual([other])
      expect(reportCodexTrustWriteRefusals(refusal)).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('/tmp/report-once-probe/config.toml')
    } finally {
      warn.mockRestore()
    }
  })

  it('logs each distinct refusal once across launches and a new message again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const systemPath = '/tmp/report-once-launches/system.toml'
      const runtimePath = '/tmp/report-once-launches/runtime.toml'
      const refusal = (configPath: string, line = 2) =>
        new CodexConfigTomlEditRefusedError({
          reason: 'input-invalid',
          detail: 'the file is not valid TOML',
          line,
          configPath
        })
      for (let launch = 0; launch < 4; launch++) {
        reportCodexTrustWriteRefusals(
          new AggregateError([refusal(systemPath), refusal(runtimePath)], 'trust write failed')
        )
        reportCodexConfigTomlEditRefusal(refusal(systemPath), 'Skipped promoting Codex settings')
      }
      expect(warn).toHaveBeenCalledTimes(3)

      reportCodexTrustWriteRefusals(refusal(systemPath, 7))
      expect(warn).toHaveBeenCalledTimes(4)
      expect(String(warn.mock.calls[3]?.[0])).toContain('(line 7)')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('a hook trust edit with nothing to write', () => {
  const handBroken = 'model = "a"\nbroken = \n'

  it('leaves a config Codex cannot parse as it is instead of refusing', () => {
    expect(upsertHookTrustEntriesInContent(handBroken, [])).toBe(handBroken)
    expect(
      setHookTrustEnabledContent(handBroken, [{ key: '/rt/hooks.json:stop:0:0', enabled: false }])
    ).toBe(handBroken)
  })
})

describe('a whole-document mirror result', () => {
  const unreadable = 'model = "a"\nmodel = "b"\n'
  const refuse = (inputs: (string | null)[]) =>
    refuseUnreadableCodexConfigResult({
      configPath: '/tmp/mirror-result-probe/config.toml',
      result: unreadable,
      inputs,
      context: 'Skipped mirroring the Codex config into a managed home'
    })

  it('is refused when every input parses, counting Orca-repairable duplicates as parsing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const orcaDuplicates =
        '["projects"."/r"]\ntrust_level = "trusted"\n\n[projects."/r"]\ntrust_level = "trusted"\n'
      expect(refuse(['model = "a"\n', null, orcaDuplicates])).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('is written as before when an input was broken by hand', () => {
    expect(refuse(['model = "a"\n', 'broken = \n'])).toBe(false)
  })
})
