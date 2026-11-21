import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from './bundled-skill-guides'
import {
  filterPlatformBlocks,
  platformBlockProblems,
  resolveGuidePlatform
} from './skill-guide-platform'

const GUIDE = [
  'Shared intro.',
  '',
  '- shared item',
  '<!-- platform: macos -->',
  '- mac item',
  '<!-- /platform -->',
  '<!-- platform: linux windows -->',
  '- linux and windows item',
  '<!-- /platform -->',
  '',
  '<!-- platform: macos -->',
  'Mac paragraph one.',
  '',
  'Mac paragraph two.',
  '<!-- /platform -->',
  '',
  '<!-- platform: windows -->',
  'Windows paragraph.',
  '<!-- /platform -->',
  '',
  'Shared outro.'
].join('\n')

describe('filterPlatformBlocks', () => {
  it('keeps shared text plus the macOS blocks', () => {
    expect(filterPlatformBlocks(GUIDE, 'macos')).toBe(
      [
        'Shared intro.',
        '',
        '- shared item',
        '- mac item',
        '',
        'Mac paragraph one.',
        '',
        'Mac paragraph two.',
        '',
        'Shared outro.'
      ].join('\n')
    )
  })

  it('keeps blocks shared by several platforms and drops blank lines left by removed blocks', () => {
    expect(filterPlatformBlocks(GUIDE, 'linux')).toBe(
      ['Shared intro.', '', '- shared item', '- linux and windows item', '', 'Shared outro.'].join(
        '\n'
      )
    )
    expect(filterPlatformBlocks(GUIDE, 'windows')).toBe(
      [
        'Shared intro.',
        '',
        '- shared item',
        '- linux and windows item',
        '',
        'Windows paragraph.',
        '',
        'Shared outro.'
      ].join('\n')
    )
  })

  it('keeps every block without markers for all', () => {
    const all = filterPlatformBlocks(GUIDE, 'all')
    expect(all).not.toContain('<!--')
    expect(all).toContain('- mac item\n- linux and windows item')
    expect(all).toContain('Mac paragraph two.\n\nWindows paragraph.\n\nShared outro.')
  })

  it('collapses the blank lines oxfmt puts around markers', () => {
    const formatted = [
      'Shared.',
      '',
      '<!-- platform: macos -->',
      '',
      '- mac item',
      '',
      '<!-- /platform -->',
      '<!-- platform: linux -->',
      '',
      'Linux paragraph.',
      '<!-- /platform -->',
      '',
      'End.'
    ].join('\n')
    expect(filterPlatformBlocks(formatted, 'macos')).toBe('Shared.\n\n- mac item\n\nEnd.')
    expect(filterPlatformBlocks(formatted, 'linux')).toBe('Shared.\n\nLinux paragraph.\n\nEnd.')
    expect(filterPlatformBlocks(formatted, 'windows')).toBe('Shared.\n\nEnd.')
    expect(filterPlatformBlocks(formatted, 'all')).toBe(
      'Shared.\n\n- mac item\n\nLinux paragraph.\n\nEnd.'
    )
  })

  it('returns text without blocks unchanged', () => {
    expect(filterPlatformBlocks('a\n\n\nb', 'linux')).toBe('a\n\n\nb')
  })
})

describe('platformBlockProblems', () => {
  it('reports unknown, nested, unclosed and inline markers', () => {
    expect(platformBlockProblems('<!-- platform: beos -->\nx\n<!-- /platform -->')).toEqual([
      'line 1: unknown platform beos'
    ])
    expect(
      platformBlockProblems(
        '<!-- platform: macos -->\n<!-- platform: linux -->\n<!-- /platform -->'
      )
    ).toEqual(['line 2: platform block opened inside the block from line 1'])
    expect(platformBlockProblems('<!-- platform: macos -->\nx')).toEqual([
      'line 1: platform block is never closed'
    ])
    expect(platformBlockProblems('x <!-- /platform -->')).toEqual([
      'line 1: platform marker must be alone on its line'
    ])
  })

  it('accepts every bundled guide and reference', () => {
    for (const guide of BUNDLED_SKILL_GUIDES) {
      expect(platformBlockProblems(guide.markdown), guide.name).toEqual([])
      for (const reference of guide.references) {
        expect(platformBlockProblems(reference.markdown), reference.name).toEqual([])
      }
    }
  })

  it('leaves no platform-only paragraph outside a block in the computer-use guide', () => {
    const guide = BUNDLED_SKILL_GUIDES.find((entry) => entry.name === 'orca-computer-use')
    const shared = filterPlatformBlocks(guide?.markdown ?? '', 'linux')
    expect(shared).not.toMatch(/^(- )?On (macOS|Windows),/m)
    expect(filterPlatformBlocks(guide?.markdown ?? '', 'macos')).not.toMatch(
      /^(- )?On (Linux|Windows)/m
    )
  })
})

describe('resolveGuidePlatform', () => {
  const host = (
    platform: NodeJS.Platform,
    extra: Partial<{ isRemote: boolean; env: NodeJS.ProcessEnv }> = {}
  ) => ({
    platform,
    isRemote: false,
    env: {},
    ...extra
  })

  it('follows the machine running the CLI', () => {
    expect(resolveGuidePlatform(new Map(), host('darwin'))).toBe('macos')
    expect(resolveGuidePlatform(new Map(), host('win32'))).toBe('windows')
    expect(resolveGuidePlatform(new Map(), host('linux'))).toBe('linux')
    expect(resolveGuidePlatform(new Map(), host('freebsd'))).toBe('all')
  })

  it('serves every platform when the acting machine may differ', () => {
    expect(resolveGuidePlatform(new Map(), host('darwin', { isRemote: true }))).toBe('all')
    expect(
      resolveGuidePlatform(new Map(), host('linux', { env: { WSL_DISTRO_NAME: 'Ubuntu' } }))
    ).toBe('all')
  })

  it('honors --platform and rejects unknown names', () => {
    expect(resolveGuidePlatform(new Map([['platform', 'Windows']]), host('darwin'))).toBe('windows')
    expect(resolveGuidePlatform(new Map([['platform', 'all']]), host('darwin'))).toBe('all')
    expect(() => resolveGuidePlatform(new Map([['platform', 'beos']]), host('darwin'))).toThrow(
      /Unknown --platform "beos"/
    )
    expect(() => resolveGuidePlatform(new Map([['platform', true]]), host('darwin'))).toThrow(
      /Unknown --platform/
    )
  })
})
