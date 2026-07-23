import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../src/shared/skills'
import type { NativeChatSkillDiscoverySnapshot } from '../../../src/shared/native-chat/native-chat-composer-state'
import {
  deriveMobileNativeChatAutocomplete,
  rankSuggestions
} from './mobile-native-chat-autocomplete'

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  const name = overrides.name ?? 'deploy'
  const rootPath = overrides.rootPath ?? '/repo/.agents/skills'
  return {
    id: name,
    name,
    description: `Use ${name}`,
    providers: ['agent-skills'],
    sourceKind: 'repo',
    sourceLabel: 'Project',
    rootPath,
    directoryPath: `${rootPath}/${name}`,
    skillFilePath: `${rootPath}/${name}/SKILL.md`,
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

function ready(skills: DiscoveredSkill[]): NativeChatSkillDiscoverySnapshot {
  return { status: 'ready', skills }
}

describe('deriveMobileNativeChatAutocomplete', () => {
  it('uses the Codex dollar trigger after whitespace and keeps slash commands separate', () => {
    const discovery = ready([skill({ name: 'deploy' })])
    expect(deriveMobileNativeChatAutocomplete('use $dep', 8, 'codex', discovery)).toMatchObject({
      mode: 'skill',
      query: 'dep',
      prefix: '$'
    })
    const slash = deriveMobileNativeChatAutocomplete('/', 1, 'codex', discovery)
    expect(slash.mode).toBe('slash')
    if (slash.mode === 'slash') {
      expect(slash.items.every((item) => item.kind === 'command')).toBe(true)
    }
  })

  it('opens Claude slash skills only when the entire draft starts with the token', () => {
    const discovery = ready([skill({ name: 'browser' })])
    expect(deriveMobileNativeChatAutocomplete('/bro', 4, 'claude', discovery).mode).toBe('slash')
    expect(deriveMobileNativeChatAutocomplete('try /bro', 8, 'claude', discovery).mode).toBe('none')
    expect(deriveMobileNativeChatAutocomplete('try\n/bro', 8, 'claude', discovery).mode).toBe(
      'none'
    )
  })

  it('routes @file mentions without also opening the picker', () => {
    expect(deriveMobileNativeChatAutocomplete('open @src', 9, 'codex').mode).toBe('mention')
  })

  it('returns the full bare-prefix list and applies shared query ranking', () => {
    const discovery = ready([
      skill({ name: 'deploy' }),
      skill({ name: 'deployment', skillFilePath: '/repo/deployment/SKILL.md' }),
      skill({
        name: 'release',
        description: 'Deploy an app',
        skillFilePath: '/repo/release/SKILL.md'
      })
    ])
    const bare = deriveMobileNativeChatAutocomplete('$', 1, 'codex', discovery)
    expect(bare.mode).toBe('skill')
    if (bare.mode === 'skill') {
      expect(bare.items.map((item) => item.name)).toEqual(['deploy', 'deployment', 'release'])
    }
    const filtered = deriveMobileNativeChatAutocomplete('$deploy', 7, 'codex', discovery)
    expect(filtered.mode).toBe('skill')
    if (filtered.mode === 'skill') {
      expect(filtered.items.map((item) => item.name)).toEqual(['deploy', 'deployment', 'release'])
    }
  })

  it('preserves collision and plugin metadata from the shared adapter', () => {
    const collision = deriveMobileNativeChatAutocomplete(
      '/clear',
      6,
      'claude',
      ready([skill({ name: 'clear' })])
    )
    expect(collision.mode).toBe('slash')
    if (collision.mode === 'slash') {
      expect(collision.items).toContainEqual(
        expect.objectContaining({ kind: 'command', name: 'clear', skillCollision: true })
      )
    }

    const plugin = deriveMobileNativeChatAutocomplete(
      '$plugin',
      7,
      'codex',
      ready([
        skill({
          name: 'plugin-skill',
          sourceKind: 'plugin',
          skillFilePath: '/plugin/skills/plugin-skill/SKILL.md'
        })
      ])
    )
    expect(plugin.mode).toBe('skill')
    if (plugin.mode === 'skill') {
      expect(plugin.items[0]).toMatchObject({
        kind: 'skill',
        sources: [expect.objectContaining({ sourceKind: 'plugin' })]
      })
    }
  })

  it('disables command and skill picking for unsupported agents', () => {
    expect(deriveMobileNativeChatAutocomplete('/', 1, 'opencode').mode).toBe('none')
    expect(
      deriveMobileNativeChatAutocomplete('$deploy', 7, 'opencode', ready([skill()])).mode
    ).toBe('none')
    expect(deriveMobileNativeChatAutocomplete('@src', 4, 'opencode').mode).toBe('mention')
  })
})

describe('rankSuggestions', () => {
  it('prefers prefix matches on the basename', () => {
    const out = rankSuggestions(['src/app/Main.tsx', 'src/AppBar.tsx', 'lib/zapp.ts'], 'app')
    expect(out[0]).toBe('src/AppBar.tsx')
    expect(out).toContain('lib/zapp.ts')
  })

  it('returns the head of the list for an empty query', () => {
    expect(rankSuggestions(['a', 'b', 'c'], '', 2)).toEqual(['a', 'b'])
  })
})
