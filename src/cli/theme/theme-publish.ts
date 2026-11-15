import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { validatePluginTarget } from '../plugins/authoring/plugin-folder-validation'
import { pluginReleaseEntryForFolder } from '../plugins/authoring/plugin-release-entry'
import { ThemeStudioError } from '../../shared/theme-studio/theme-studio-errors'
import { themeStudioPluginFiles } from '../../shared/theme-studio/theme-studio-plugin-files'
import {
  themeStudioPublishKitSchema,
  type ThemeStudioPublishKit
} from '../../shared/theme-studio/theme-studio-protocol'
import { call, localPath, print, stringFlag } from './theme-command-io'
import {
  assertGitIdentity,
  assertNotOlderVersion,
  publishSteps,
  runPublishSteps,
  shellLine
} from './theme-publish-steps'

const DEFAULT_VERSION = '1.0.0'
// Why longer than other theme calls: the host draws three images before answering.
const PUBLISH_KIT_TIMEOUT_MS = 90_000
const COMMUNITY_CATALOG = 'stablyai/orca-community-plugins'
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

/** The GitHub user `gh` is signed in as, or null when gh is missing or signed out. */
async function githubUser(): Promise<string | null> {
  try {
    const result = await runProcess({
      program: 'gh',
      args: ['api', 'user', '--jq', '.login'],
      timeoutMs: 15_000
    })
    const login = result.stdout.trim()
    return result.code === 0 && OWNER.test(login) ? login : null
  } catch {
    return null
  }
}

function parseRepo(value: string | undefined): { owner?: string; name?: string } {
  if (value === undefined) {
    return {}
  }
  const parts = value.split('/')
  const [owner, name] = parts
  if (parts.length !== 2 || !OWNER.test(owner) || !REPO.test(name) || /^\.+$/.test(name)) {
    throw new RuntimeClientError('invalid_argument', '--repo must look like owner/name.')
  }
  return { owner, name }
}

const notUsable = (folder: string, why: string): RuntimeClientError =>
  new RuntimeClientError('invalid_argument', `${folder} ${why}`, {
    nextSteps: ['Pass --dir with a new or empty folder.']
  })

/**
 * A folder that is new, empty, or this theme's earlier publish folder (a re-run or a new version)
 * holding only what this command writes, so nothing else in it can become public.
 */
function assertUsableFolder(folder: string, id: string, topLevel: ReadonlySet<string>): void {
  if (!existsSync(folder) || readdirSync(folder).length === 0) {
    return
  }
  let sameTheme = false
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(folder, 'orca-plugin.json'), 'utf8'))
    sameTheme =
      typeof manifest === 'object' && manifest !== null && 'id' in manifest && manifest.id === id
  } catch {
    sameTheme = false
  }
  if (!sameTheme) {
    throw notUsable(folder, 'is not empty.')
  }
  const extra = readdirSync(folder).filter((name) => name !== '.git' && !topLevel.has(name))
  if (extra.length > 0) {
    throw notUsable(folder, `has files this command did not write: ${extra.join(', ')}.`)
  }
}

/** Why: a link inside a reused folder would make a write land outside it. */
function assertNoLinks(folder: string, paths: readonly string[]): void {
  for (const path of paths) {
    const parts = path.split('/')
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const target = join(folder, ...parts.slice(0, depth))
      let linked = false
      try {
        linked = lstatSync(target).isSymbolicLink()
      } catch {
        break
      }
      if (linked) {
        throw notUsable(folder, `has a link at ${parts.slice(0, depth).join('/')}.`)
      }
    }
  }
}

function kitFiles(kit: ThemeStudioPublishKit, version: string): Record<string, string | Buffer> {
  let files: Record<string, string>
  try {
    files = themeStudioPluginFiles(kit.draft, kit.id, {
      version,
      cover: { path: 'images/cover.png', alt: `The ${kit.name} theme in Orca` },
      screenshots: kit.images.screenshots.map(({ mode }) => ({
        path: `images/${mode}.png`,
        alt: `The ${kit.name} theme in Orca, ${mode} mode`,
        caption: `${kit.name} in ${mode} mode`,
        theme: mode
      }))
    }).files
  } catch (error) {
    throw error instanceof ThemeStudioError
      ? new RuntimeClientError(error.code, error.message, error.data)
      : error
  }
  return {
    ...files,
    'images/cover.png': Buffer.from(kit.images.cover.png, 'base64'),
    ...Object.fromEntries(
      kit.images.screenshots.map((shot) => [
        `images/${shot.mode}.png`,
        Buffer.from(shot.png, 'base64')
      ])
    )
  }
}

async function writeKit(folder: string, files: Record<string, string | Buffer>): Promise<void> {
  assertNoLinks(folder, Object.keys(files))
  // Why clear images: a mode the theme no longer has must not be published from an earlier run.
  await rm(join(folder, 'images'), { recursive: true, force: true })
  for (const [path, body] of Object.entries(files)) {
    const file = join(folder, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
  }
}

function printPlan(
  ctx: HandlerContext,
  plan: {
    folder: string
    files: string[]
    version: string
    steps: { label: string; command: string }[]
  },
  input: { name: string; slug: string; signedIn: boolean; rerun: string }
): void {
  print(
    ctx,
    {
      status: 'planned',
      ...plan,
      repository: {
        slug: input.slug,
        url: `https://github.com/${input.slug}`,
        visibility: 'public'
      },
      nextSteps: [
        ...(input.signedIn
          ? []
          : ['Sign in with `gh auth login` (or pass --repo owner/name) before publishing.']),
        'Show the user this plan: everything in the folder becomes public at the repository URL.',
        `Only after they say yes, run: ${input.rerun}`
      ]
    },
    [
      `Plan (nothing is published yet): ${input.name} ${plan.version}`,
      `  folder: ${plan.folder} (${plan.files.length} files, passes \`orca plugin validate\`)`,
      `  public repository: https://github.com/${input.slug}`,
      ...plan.steps.map((step, index) => `  ${index + 1}. ${step.label}: ${step.command}`),
      input.signedIn
        ? `Ask the user; only when they agree, run: ${input.rerun}`
        : 'Sign in with `gh auth login` (or pass --repo owner/name) to publish.'
    ].join('\n')
  )
}

/**
 * `orca theme publish`: writes a validated plugin folder with images drawn from the theme, and
 * plans its public repository. Only with --yes, given after the person agreed to that plan, does
 * it commit, create the repository, tag, add the topic and cut the release.
 */
export async function publishTheme(ctx: HandlerContext): Promise<void> {
  const pluginKey = stringFlag(ctx, 'plugin')
  if (!pluginKey) {
    throw new RuntimeClientError('invalid_argument', 'Missing <plugin-key>.', {
      nextSteps: ['Use the key `orca theme apply` printed, or the one Settings → Appearance shows.']
    })
  }
  const version = stringFlag(ctx, 'version') ?? DEFAULT_VERSION
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new RuntimeClientError('invalid_argument', '--version must look like 1.0.0.')
  }
  const repo = parseRepo(stringFlag(ctx, 'repo'))
  const kit = themeStudioPublishKitSchema.parse(
    await call<unknown>(ctx, 'themeStudio.publishKit', { pluginKey }, PUBLISH_KIT_TIMEOUT_MS)
  )
  // Why not the current folder: agents run in project worktrees, which must not gain a theme.
  const folder = localPath(
    ctx,
    stringFlag(ctx, 'dir') ?? join(homedir(), 'orca-themes', kit.id),
    'publish'
  )
  const contents = kitFiles(kit, version)
  const topLevel = [...new Set(Object.keys(contents).map((path) => path.split('/')[0]))]
  assertUsableFolder(folder, kit.id, new Set(topLevel))
  await assertNotOlderVersion(folder, version)
  const owner = repo.owner ?? (await githubUser())
  const slug = `${owner ?? '<your-github-user>'}/${repo.name ?? `${kit.id}-orca-theme`}`
  await writeKit(folder, contents)
  const files = Object.keys(contents)
  const validation = await validatePluginTarget(folder)
  if (!validation.valid) {
    throw new RuntimeClientError(
      'plugin_invalid',
      `The theme folder does not pass \`orca plugin validate\`: ${validation.errors.join('; ')}`,
      {
        errors: validation.errors,
        nextSteps: [`Fix it with \`orca theme edit --from ${pluginKey}\`, save, and publish again.`]
      }
    )
  }
  const steps = publishSteps({ folder, slug, name: kit.name, version, files: topLevel })
  const plan = {
    pluginKey,
    folder,
    files,
    version,
    steps: steps.map((step) => ({ label: step.label, command: shellLine(step.command) }))
  }
  // Why `=== true`: `--yes=false` must plan, not publish.
  if (ctx.flags.get('yes') !== true || owner === null) {
    const rerun = shellLine([
      'orca',
      'theme',
      'publish',
      pluginKey,
      '--dir',
      folder,
      '--repo',
      slug,
      '--version',
      version,
      '--yes'
    ])
    printPlan(ctx, plan, { name: kit.name, slug, signedIn: owner !== null, rerun })
    return
  }
  await assertGitIdentity(folder)
  const done = await runPublishSteps(steps)
  const entry = await validatePluginTarget(folder)
    .then(pluginReleaseEntryForFolder)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
    )
  print(
    ctx,
    {
      status: 'published',
      ...plan,
      repository: { slug, url: `https://github.com/${slug}`, visibility: 'public' },
      done,
      ...('value' in entry ? { releaseEntry: entry.value } : { releaseEntryError: entry.error }),
      install: `orca plugin install ${slug}`,
      listing: `https://orca.dev/plugins/${slug}`,
      nextSteps: [
        `Anyone can install it now with: orca plugin install ${slug}`,
        `To list it in Orca's community catalog, ask the user first; then fork ${COMMUNITY_CATALOG}, add the release entry to orca-catalog.json and open a pull request.`
      ]
    },
    [
      `Published ${kit.name} ${version} to https://github.com/${slug}`,
      ...done.map((label) => `  ✓ ${label}`),
      `Install: orca plugin install ${slug}`,
      `Listing: https://orca.dev/plugins/${slug}`,
      'value' in entry
        ? `For a catalog (ask the user first): \`orca plugin release-entry ${shellLine([folder])}\` prints the entry for a pull request on ${COMMUNITY_CATALOG}.`
        : `The release entry could not be read: ${entry.error}`
    ].join('\n')
  )
}
