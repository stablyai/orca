import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectedOrDetectedSkillProviders } from '../../shared/skill-install-providers'
import { resolveSkillProviderDestinations } from './skill-provider-destinations'

const HOME = join('/home', 'dev')
const WORKSPACE = join('/repos', 'orca')

describe('resolveSkillProviderDestinations', () => {
  it('gives an agent that reads the canonical root no placement of its own', () => {
    const destinations = resolveSkillProviderDestinations({
      scope: 'workspace',
      homeDirectory: HOME,
      workspaceDirectory: WORKSPACE,
      detectedProviders: ['codex']
    })
    expect(destinations).toEqual([
      {
        provider: 'codex',
        readsCanonicalRoot: true,
        rootPath: join(WORKSPACE, '.agents', 'skills')
      }
    ])
  })

  // Why: Codex and Cursor read a project's .agents/skills but keep their own
  // home directory, so the same agent needs a placement at one scope only.
  it('resolves scope-specific roots for an agent that is canonical in a workspace only', () => {
    const workspace = resolveSkillProviderDestinations({
      scope: 'workspace',
      homeDirectory: HOME,
      workspaceDirectory: WORKSPACE,
      detectedProviders: ['cursor']
    })
    const global = resolveSkillProviderDestinations({
      scope: 'global',
      homeDirectory: HOME,
      detectedProviders: ['cursor']
    })
    expect(workspace[0]).toMatchObject({ readsCanonicalRoot: true })
    expect(global[0]).toMatchObject({
      readsCanonicalRoot: false,
      rootPath: join(HOME, '.cursor', 'skills')
    })
  })

  it('places every detected agent that owns a directory', () => {
    const destinations = resolveSkillProviderDestinations({
      scope: 'global',
      homeDirectory: HOME,
      detectedProviders: ['codex', 'claude', 'droid', 'grok', 'aug', 'continue', 'trae']
    })
    expect(destinations.map((destination) => destination.rootPath)).toEqual([
      join(HOME, '.agents', 'skills'),
      join(HOME, '.claude', 'skills'),
      join(HOME, '.factory', 'skills'),
      join(HOME, '.continue', 'skills'),
      join(HOME, '.trae-cn', 'skills'),
      join(HOME, '.grok', 'skills'),
      join(HOME, '.augment', 'skills')
    ])
  })

  it('uses the canonical root for Codex at global scope', () => {
    expect(
      resolveSkillProviderDestinations({
        scope: 'global',
        homeDirectory: HOME,
        detectedProviders: ['codex']
      })
    ).toEqual([
      { provider: 'codex', readsCanonicalRoot: true, rootPath: join(HOME, '.agents', 'skills') }
    ])
  })

  it('honors custom global config roots without changing workspace roots', () => {
    const customClaudeRoot = join('/srv', 'claude', 'skills')
    expect(
      resolveSkillProviderDestinations({
        scope: 'global',
        homeDirectory: HOME,
        detectedProviders: ['claude'],
        providerRootOverrides: { claude: customClaudeRoot }
      })
    ).toEqual([{ provider: 'claude', readsCanonicalRoot: false, rootPath: customClaudeRoot }])
    expect(
      resolveSkillProviderDestinations({
        scope: 'workspace',
        homeDirectory: HOME,
        workspaceDirectory: WORKSPACE,
        detectedProviders: ['claude'],
        providerRootOverrides: { claude: customClaudeRoot }
      })[0]?.rootPath
    ).toBe(join(WORKSPACE, '.claude', 'skills'))
  })

  it('treats a custom root equal to canonical as canonical', () => {
    expect(
      resolveSkillProviderDestinations({
        scope: 'global',
        homeDirectory: HOME,
        detectedProviders: ['claude'],
        providerRootOverrides: { claude: join(HOME, '.agents', 'skills') }
      })
    ).toEqual([
      {
        provider: 'claude',
        readsCanonicalRoot: true,
        rootPath: join(HOME, '.agents', 'skills')
      }
    ])
  })

  it('rejects two providers claiming one noncanonical root', () => {
    const sharedRoot = join(HOME, '.custom-agent', 'skills')
    expect(() =>
      resolveSkillProviderDestinations({
        scope: 'global',
        homeDirectory: HOME,
        detectedProviders: ['claude', 'grok'],
        providerRootOverrides: { claude: sharedRoot, grok: sharedRoot }
      })
    ).toThrow('skill-install-provider-root-collision')
  })

  it('ignores agents Orca cannot place skills for', () => {
    expect(
      resolveSkillProviderDestinations({
        scope: 'global',
        homeDirectory: HOME,
        detectedProviders: ['opencode', 'goose', 'not-an-agent']
      })
    ).toEqual([])
  })

  it('requires a workspace directory for workspace scope', () => {
    expect(() =>
      resolveSkillProviderDestinations({
        scope: 'workspace',
        homeDirectory: HOME,
        detectedProviders: ['claude']
      })
    ).toThrow('skill-install-workspace-required')
  })
})

describe('selectedOrDetectedSkillProviders', () => {
  // Why: removal passes no selection so it can still clean roots an earlier
  // install wrote, even if the user has since narrowed their agents.
  it('keeps every detected agent when nothing was selected', () => {
    expect(selectedOrDetectedSkillProviders(['claude', 'codex'], undefined)).toEqual([
      'claude',
      'codex'
    ])
  })

  it('honors selected agents even when they are not currently detected', () => {
    expect(selectedOrDetectedSkillProviders(['claude', 'codex'], ['claude', 'cursor'])).toEqual([
      'claude',
      'cursor'
    ])
  })

  it('places nothing extra when the choice is empty', () => {
    expect(selectedOrDetectedSkillProviders(['claude', 'codex'], [])).toEqual([])
  })
})
