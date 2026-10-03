import { describe, expect, it } from 'vitest'
import {
  parseHookStateTomlHeaderKey,
  parseProjectTomlHeaderPath,
  parseStandardTableHeaderSegments
} from './config-toml-syntax'
import { isRuntimeHookTrustTomlSection } from './config-toml-runtime-owned-sections'

function fullProjectParse(line: string): string | null {
  const segments = parseStandardTableHeaderSegments(line)
  return segments?.length === 2 && segments[0] === 'projects' ? (segments[1] ?? null) : null
}

describe('header fast paths agree with the full key-path parse', () => {
  it.each([
    ['[projects."/work/repo"]', '/work/repo'],
    ['  [ projects . "/work/repo" ]  # note "quoted" ]', '/work/repo'],
    ['[projects."/work/a#b]c"]\r', '/work/a#b]c'],
    ['[projects."C:\\\\Users\\\\me"]', 'C:\\Users\\me'],
    ['["\\u0070rojects"."/work/repo"]', '/work/repo'],
    ["['projects'.'/work/repo']", '/work/repo'],
    ['["projects"."/work/\\u00e9"]', '/work/é'],
    ['[projects."/work/tab\there"]', '/work/tab\there'],
    ['[projects."/work/😀"]', '/work/😀'],
    ['[[projects."/work/repo"]]', null],
    ['[projects."/work/repo".child]', null],
    ['[projects."/work/repo"] trailing', null],
    ['[model_providers."x"]', null],
    ['model = "projects"', null]
  ])('parses %j as %j', (line, expected) => {
    expect(parseProjectTomlHeaderPath(line)).toBe(expected)
    expect(fullProjectParse(line)).toBe(expected)
  })

  it('still recognizes hooks.state tables spelled with escapes', () => {
    const escaped = '["hoo\\u006bs"."\\u0073tate"."/h.json:stop:0:0"]'
    expect(parseHookStateTomlHeaderKey(escaped)).toBe('/h.json:stop:0:0')
    expect(isRuntimeHookTrustTomlSection(escaped)).toBe(true)
    expect(isRuntimeHookTrustTomlSection('[hooks.state]')).toBe(true)
    expect(isRuntimeHookTrustTomlSection('[projects."/hooks/state"]')).toBe(false)
    expect(isRuntimeHookTrustTomlSection('[mcp_servers.x]')).toBe(false)
  })
})
