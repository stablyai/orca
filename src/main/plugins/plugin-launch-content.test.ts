import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  pluginMarketplaceSchema
} from '../../shared/plugins/plugin-marketplace'
import { bootstrapBundledPlugins, resolveBundledPluginRoot } from './plugin-bundled-bootstrap'
import { hashPluginTree } from './plugin-content-hash'
import { inspectPluginInstallTree } from './plugin-install-staging'

const launchRoot = join(process.cwd(), 'resources', 'plugins', 'launch')
const temporaryRoots: string[] = []

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function hexRelativeLuminance(value: string): number {
  const channels = value
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function hexContrastRatio(first: string, second: string): number {
  const luminances = [hexRelativeLuminance(first), hexRelativeLuminance(second)].sort(
    (left, right) => right - left
  )
  return (luminances[0]! + 0.05) / (luminances[1]! + 0.05)
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Phase 1 launch plugin content', () => {
  it('lists and validates at least eight representative plugin packs', async () => {
    const marketplace = pluginMarketplaceSchema.parse(
      await readJson(join(launchRoot, 'orca-marketplace.json'))
    )
    expect(marketplace.plugins.length).toBeGreaterThanOrEqual(7)
    expect(
      marketplace.plugins.filter(
        (plugin) =>
          isOfficialPluginIdentity(plugin.id) && isOfficialOrganizationGitSource(plugin.source.url)
      ).length
    ).toBeGreaterThanOrEqual(2)

    const localPluginDirectories = (await readdir(launchRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(marketplace.plugins.map((plugin) => plugin.id).sort()).toEqual(
      localPluginDirectories.filter((pluginId) => pluginId !== 'stablyai.orca-curated-themes')
    )
    expect(localPluginDirectories).toContain('stablyai.orca-curated-themes')

    const contributionKinds = new Set<string>()
    for (const pluginId of localPluginDirectories) {
      const inspection = await inspectPluginInstallTree({
        rootDir: join(launchRoot, pluginId),
        hostVersion: '1.4.0',
        expectedPluginKey: pluginId
      })
      expect(inspection, `${pluginId} must pass the production install inspection`).toMatchObject({
        ok: true
      })
      if (!inspection.ok) {
        continue
      }
      const contributes = inspection.manifest.contributes
      if (contributes.themes.length > 0) {
        contributionKinds.add('theme')
      }
      if (contributes.languagePacks.length > 0) {
        contributionKinds.add('language')
      }
      if (contributes.iconThemes.length > 0) {
        contributionKinds.add('icon')
      }
      if (contributes.terminalThemes.length > 0) {
        contributionKinds.add('terminal-theme')
      }
      if (contributes.vmRecipes.length > 0) {
        contributionKinds.add('vm-recipe')
      }
      if (contributes.commands.length > 0 && contributes.keybindings.length > 0) {
        contributionKinds.add('command-keybinding')
      }
      if (pluginId === 'stablyai.orca-curated-themes') {
        expect(contributes.themes.map((theme) => theme.id)).toContain('paper-light')
        expect(contributes.themes.map((theme) => theme.id)).toContain('stage-dark')
        expect(contributes.terminalThemes.map((theme) => theme.id)).toContain('paper-terminal')
        expect(contributes.terminalThemes.map((theme) => theme.id)).toContain('stage-terminal')
      }
    }
    expect(contributionKinds).toEqual(
      new Set(['theme', 'language', 'icon', 'terminal-theme', 'vm-recipe', 'command-keybinding'])
    )
  })

  it('publishes every bundled pack only when its release hash matches exact bytes', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-launch-content-'))
    temporaryRoots.push(userDataPath)

    const result = await bootstrapBundledPlugins({
      root: launchRoot,
      userDataPath,
      hostVersion: '1.4.0'
    })

    expect(result.errors).toEqual([])
    expect(result.installed.length).toBeGreaterThanOrEqual(1)
    expect(result.installed.every(isOfficialPluginIdentity)).toBe(true)
  })

  it('publishes the bundled curated theme pack from its exact release bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-curated-themes-bundle-'))
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-curated-themes-user-data-'))
    temporaryRoots.push(root, userDataPath)
    const pluginKey = 'stablyai.orca-curated-themes'
    const pluginRoot = join(root, pluginKey)
    await cp(join(launchRoot, pluginKey), pluginRoot, { recursive: true })
    const hashed = await hashPluginTree(pluginRoot)
    expect(hashed.ok).toBe(true)
    if (!hashed.ok) {
      return
    }
    await writeFile(
      join(root, 'bundled-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: [{ pluginKey, path: pluginKey, contentHash: hashed.hash }]
      })
    )

    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toMatchObject({ installed: [pluginKey], errors: [] })
  })

  it.each(['paper-light.json', 'stage-dark.json'])(
    'keeps curated theme foreground pairs readable in %s',
    async (fileName) => {
      const theme = (await readJson(
        join(launchRoot, 'stablyai.orca-curated-themes', 'themes', fileName)
      )) as { tokens: Record<string, string> }
      const pairs = [
        ['--background', '--foreground'],
        ['--card', '--card-foreground'],
        ['--popover', '--popover-foreground'],
        ['--primary', '--primary-foreground'],
        ['--secondary', '--secondary-foreground'],
        ['--muted', '--muted-foreground'],
        ['--accent', '--accent-foreground'],
        ['--destructive', '--destructive-foreground'],
        ['--sidebar', '--sidebar-foreground'],
        ['--worktree-sidebar', '--worktree-sidebar-foreground'],
        ['--right-sidebar', '--right-sidebar-foreground'],
        ['--appearance-state-hover', '--appearance-state-hover-foreground'],
        ['--appearance-state-selected', '--appearance-state-selected-foreground'],
        ['--appearance-state-current', '--appearance-state-current-foreground']
      ] as const

      for (const [surface, foreground] of pairs) {
        expect(
          hexContrastRatio(theme.tokens[surface]!, theme.tokens[foreground]!)
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it('uses paper green for selection and orange for focus and current context', async () => {
    const theme = (await readJson(
      join(launchRoot, 'stablyai.orca-curated-themes', 'themes', 'paper-light.json')
    )) as { terminalThemeContributionId: string; tokens: Record<string, string> }

    expect(theme.terminalThemeContributionId).toBe('paper-terminal')
    expect(theme.tokens['--primary']).toBe('#669B5B')
    expect(theme.tokens['--appearance-state-selected']).toBe('#669B5B')
    expect(theme.tokens['--appearance-state-selected-foreground']).toBe('#102015')
    expect(theme.tokens['--appearance-state-current']).toBe('#E4A83B')
    expect(theme.tokens['--ring']).toBe('#D19A34')
    expect(theme.tokens['--appearance-state-hover-border']).toBe('#D19A34')
  })

  it('uses the checked-in stage stripe texture without recoloring it', async () => {
    const texture = await readFile(
      join(launchRoot, 'stablyai.orca-curated-themes', 'textures', 'stage.png')
    )
    expect(createHash('sha256').update(texture).digest('hex')).toBe(
      '26660e41ccbf3c4971e4313e8ce9542c3846ed0693172b131bc6cebf6b9254b9'
    )
  })

  it.each([
    ['paper-light.json', '#ECE7DC', '#262626'],
    ['stage-dark.json', '#262626', '#ECE7DC']
  ] as const)(
    'ships linked curated terminal colors in %s',
    async (fileName, background, foreground) => {
      const theme = (await readJson(
        join(launchRoot, 'stablyai.orca-curated-themes', 'terminal', fileName)
      )) as { terminal: Record<string, string> }

      expect(theme.terminal.background).toBe(background)
      expect(theme.terminal.foreground).toBe(foreground)
      expect(hexContrastRatio(background, foreground)).toBeGreaterThanOrEqual(7)
      expect(
        hexContrastRatio(theme.terminal.selectionBackground!, theme.terminal.selectionForeground!)
      ).toBeGreaterThanOrEqual(7)
    }
  )

  it('boots release-indexed content from the packaged resources layout', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'orca-packaged-resources-'))
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-packaged-user-data-'))
    temporaryRoots.push(resourcesPath, userDataPath)
    const packagedRoot = join(resourcesPath, 'plugins', 'launch')
    await cp(launchRoot, packagedRoot, { recursive: true })

    const result = await bootstrapBundledPlugins({
      root: resolveBundledPluginRoot({
        isPackaged: true,
        resourcesPath,
        appPath: join(resourcesPath, 'app.asar')
      }),
      userDataPath,
      hostVersion: '1.4.0'
    })

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual([
      'stablyai.orca-midnight-theme',
      'stablyai.orca-navigation-shortcuts',
      'stablyai.orca-curated-themes'
    ])
  })
})
