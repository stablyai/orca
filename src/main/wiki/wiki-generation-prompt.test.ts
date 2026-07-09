import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWikiGenerationPrompt, wikiTemplatesDirCandidates } from './wiki-generation-prompt'

describe('wikiTemplatesDirCandidates', () => {
  it('probes the asar.unpacked resources dir for packaged builds', () => {
    const candidates = wikiTemplatesDirCandidates({
      isPackaged: true,
      resourcesPath: '/Applications/Orca.app/Contents/Resources',
      appPath: '/Applications/Orca.app/Contents/Resources/app.asar'
    })
    expect(candidates).toContain(
      join(
        '/Applications/Orca.app/Contents/Resources',
        'app.asar.unpacked',
        'resources',
        'wiki-templates'
      )
    )
    expect(candidates).toContain(
      join('/Applications/Orca.app/Contents/Resources', 'wiki-templates')
    )
  })

  it('falls back to the app path when resourcesPath is undefined', () => {
    const candidates = wikiTemplatesDirCandidates({
      isPackaged: true,
      resourcesPath: undefined,
      appPath: '/Applications/Orca.app/Contents/Resources/app.asar'
    })
    expect(candidates).toEqual([
      join('/Applications/Orca.app/Contents/Resources/app.asar', 'resources', 'wiki-templates')
    ])
  })

  it('reads from the repo root in dev', () => {
    const candidates = wikiTemplatesDirCandidates({
      isPackaged: false,
      resourcesPath: '/some/dev/resourcesPath',
      appPath: '/repo/root'
    })
    expect(candidates).toEqual([join('/repo/root', 'resources', 'wiki-templates')])
  })
})

describe('buildWikiGenerationPrompt', () => {
  it('inlines the contract, templates, and repo name', async () => {
    const files: Record<string, string> = {
      'prompt.md': '# Contract\nGenerate into .wiki/.',
      'overview.md': 'OVERVIEW-TEMPLATE',
      'service.md': 'SERVICE-TEMPLATE',
      'task.md': 'TASK-TEMPLATE'
    }
    const prompt = await buildWikiGenerationPrompt({
      repoName: 'custom-pricelist-api',
      readTemplateFile: async (name) => files[name]
    })
    expect(prompt).toContain('# Contract')
    expect(prompt).toContain('custom-pricelist-api')
    expect(prompt).toContain('OVERVIEW-TEMPLATE')
    expect(prompt).toContain('SERVICE-TEMPLATE')
    expect(prompt).toContain('TASK-TEMPLATE')
  })

  const templateFiles: Record<string, string> = {
    'prompt.md': 'C',
    'overview.md': 'O',
    'service.md': 'S',
    'task.md': 'T'
  }

  it('omits the CLAUDE.md instruction by default', async () => {
    const prompt = await buildWikiGenerationPrompt({
      repoName: 'demo',
      readTemplateFile: async (name) => templateFiles[name]
    })
    expect(prompt).not.toContain('CLAUDE.md')
  })

  it('appends a CLAUDE.md instruction when addClaudeMdInstruction is true', async () => {
    const prompt = await buildWikiGenerationPrompt({
      repoName: 'demo',
      readTemplateFile: async (name) => templateFiles[name],
      addClaudeMdInstruction: true
    })
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt).toMatch(/create it/i)
  })
})
