import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const terminalLabel = 'New Orca Terminal Here'
const workspaceLabel = 'New Orca Workspace Here'
const selectedFolder = `/tmp/orca-finder/Sample Folder/it's "quoted" 🐋`
const packagedCliPath = '/Applications/Orca.app/Contents/Resources/bin/orca'

async function loadBuilder() {
  try {
    return await import('./build-finder-services.mjs')
  } catch (error) {
    throw new Error(
      `Expected config/scripts/build-finder-services.mjs to export Finder Service metadata/rendering helpers: ${error.message}`
    )
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

describe('Finder Service package build gating', () => {
  it('runs Finder Service generation only for mac package builds', () => {
    const projectDir = resolve(import.meta.dirname, '../..')
    const { scripts } = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
    expect(scripts['build:finder-services']).toBe('node config/scripts/build-finder-services.mjs')
    for (const script of ['build:desktop', 'build:win', 'build:linux', 'build:release']) {
      expect(scripts[script]).not.toContain('finder-services')
    }
    for (const script of ['build:mac', 'build:mac:release']) {
      const finderStep = scripts[script].indexOf('pnpm run build:finder-services')
      expect(finderStep).toBeGreaterThanOrEqual(0)
      expect(finderStep).toBeLessThan(scripts[script].indexOf('electron-builder'))
    }
  })
})

describe('Finder Service resource builder', () => {
  it('declares the selected-folder services with stable Finder menu labels', async () => {
    const { finderServices } = await loadBuilder()

    expect(finderServices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'terminal',
          menuLabel: terminalLabel,
          inputTypes: ['public.folder'],
          cliArgs: ['finder', 'terminal']
        }),
        expect.objectContaining({
          id: 'workspace',
          menuLabel: workspaceLabel,
          inputTypes: ['public.folder'],
          cliArgs: ['finder', 'workspace']
        })
      ])
    )
  })

  it('renders shell-safe CLI invocations for selected folder paths', async () => {
    const { finderServices, renderFinderServiceScript } = await loadBuilder()
    const terminalService = finderServices.find((service) => service.id === 'terminal')
    const workspaceService = finderServices.find((service) => service.id === 'workspace')

    const terminalScript = renderFinderServiceScript(terminalService, {
      orcaCliPath: packagedCliPath,
      selectedFolderPath: selectedFolder
    })
    const workspaceScript = renderFinderServiceScript(workspaceService, {
      orcaCliPath: packagedCliPath,
      selectedFolderPath: selectedFolder
    })

    expect(terminalScript).toContain(
      `${shellQuote(packagedCliPath)} finder terminal --path ${shellQuote(selectedFolder)}`
    )
    expect(workspaceScript).toContain(
      `${shellQuote(packagedCliPath)} finder workspace --path ${shellQuote(selectedFolder)}`
    )
    expect(terminalScript).not.toContain(`--path ${selectedFolder}`)
    expect(workspaceScript).not.toContain(`--path ${selectedFolder}`)
  })
})
