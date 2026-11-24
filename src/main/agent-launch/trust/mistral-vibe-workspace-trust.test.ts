import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { beforeEach, describe, expect, it } from 'vitest'
import { markMistralVibeWorkspaceTrusted } from './agent-trust-presets'

let home: string
let workspace: string

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'vibe-home-')))
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'vibe-ws-')))
})

function trustFile(): string {
  return join(home, '.vibe', 'trusted_folders.toml')
}

function readLists(): { trusted: string[]; untrusted: string[] } {
  const parsed = parseToml(readFileSync(trustFile(), 'utf-8')) as Record<string, string[]>
  return { trusted: parsed.trusted ?? [], untrusted: parsed.untrusted ?? [] }
}

function writeLists(trusted: string[], untrusted: string[]): void {
  mkdirSync(join(home, '.vibe'), { recursive: true })
  writeFileSync(
    trustFile(),
    `trusted = [${trusted.map((p) => JSON.stringify(p)).join(', ')}]\n` +
      `untrusted = [${untrusted.map((p) => JSON.stringify(p)).join(', ')}]\n`
  )
}

describe('markMistralVibeWorkspaceTrusted', () => {
  it('creates the store with the workspace in the trusted list', () => {
    markMistralVibeWorkspaceTrusted(workspace, {}, home)

    expect(readLists()).toEqual({ trusted: [workspace], untrusted: [] })
  })

  it('writes under VIBE_HOME when the launched agent moves it', () => {
    const moved = realpathSync.native(mkdtempSync(join(tmpdir(), 'vibe-alt-')))

    markMistralVibeWorkspaceTrusted(workspace, { VIBE_HOME: moved }, home)

    const parsed = parseToml(readFileSync(join(moved, 'trusted_folders.toml'), 'utf-8'))
    expect(parsed).toEqual({ trusted: [workspace], untrusted: [] })
  })

  it('expands a ~ VIBE_HOME against the agent home, the way Vibe does', () => {
    markMistralVibeWorkspaceTrusted(workspace, { VIBE_HOME: '~/vibe-alt' }, home)

    const parsed = parseToml(readFileSync(join(home, 'vibe-alt', 'trusted_folders.toml'), 'utf-8'))
    expect(parsed).toEqual({ trusted: [workspace], untrusted: [] })
  })

  it('resolves a relative VIBE_HOME from the folder the agent starts in', () => {
    markMistralVibeWorkspaceTrusted(workspace, { VIBE_HOME: 'alt-store' }, home)

    const parsed = parseToml(
      readFileSync(join(workspace, 'alt-store', 'trusted_folders.toml'), 'utf-8')
    )
    expect(parsed).toEqual({ trusted: [workspace], untrusted: [] })
  })

  it('moves the workspace out of untrusted, which Vibe checks first', () => {
    writeLists([], [workspace])

    markMistralVibeWorkspaceTrusted(workspace, {}, home)

    expect(readLists()).toEqual({ trusted: [workspace], untrusted: [] })
  })

  it('keeps other folders and does not duplicate an already trusted one', () => {
    writeLists(['/other/folder'], [])

    markMistralVibeWorkspaceTrusted(workspace, {}, home)
    markMistralVibeWorkspaceTrusted(workspace, {}, home)

    expect(readLists()).toEqual({ trusted: ['/other/folder', workspace], untrusted: [] })
  })

  it('leaves a store it cannot parse alone rather than replacing the user decisions', () => {
    mkdirSync(join(home, '.vibe'), { recursive: true })
    writeFileSync(trustFile(), 'trusted = "not a list"\n')

    markMistralVibeWorkspaceTrusted(workspace, {}, home)

    expect(readFileSync(trustFile(), 'utf-8')).toBe('trusted = "not a list"\n')
  })
})
