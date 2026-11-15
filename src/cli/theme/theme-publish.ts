import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { validatePluginTarget } from '../plugins/authoring/plugin-folder-validation'
import { pluginReleaseEntryForFolder } from '../plugins/authoring/plugin-release-entry'
import type {
  ThemeStudioDraft,
  ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import { ThemeStudioError } from '../../shared/theme-studio/theme-studio-errors'
import { themeStudioPluginFiles } from '../../shared/theme-studio/theme-studio-plugin-files'
import { call, localPath, print, stringFlag } from './theme-command-io'

const run = promisify(execFile)
const DEFAULT_VERSION = '1.0.0'
const COMMUNITY_CATALOG = 'stablyai/orca-community-plugins'
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/
const OWNER_NAME = /^[A-Za-z0-9-]{1,39}$/

type PublishKit = {
  pluginKey: string
  id: string
  name: string
  draft: ThemeStudioDraft
  images: {
    cover: { mode: ThemeStudioMode; png: string }
    screenshots: { mode: ThemeStudioMode; png: string }[]
  }
}

type Step = { label: string; command: string[]; cwd?: string }

/** The GitHub user `gh` is signed in as, or null when gh is missing or signed out. */
async function githubUser(): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** A folder that is new, empty, or this theme's earlier publish folder (re-run after a dry run). */
function assertUsableFolder(folder: string, id: string): void {
  if (!existsSync(folder) || readdirSync(folder).length === 0) {
    return
  }
  const manifest = join(folder, 'orca-plugin.json')
  const sameTheme = existsSync(manifest) && readFileSync(manifest, 'utf8').includes(`"id": "${id}"`)
  if (!sameTheme) {
    throw new RuntimeClientError('invalid_argument', `${folder} is not empty.`, {
      nextSteps: ['Pass --dir with a new or empty folder.']
    })
  }
}

async function writeKit(folder: string, kit: PublishKit, version: string): Promise<string[]> {
  const modes = kit.images.screenshots.map((shot) => shot.mode)
  let files: Record<string, string>
  try {
    files = themeStudioPluginFiles(kit.draft, kit.id, {
      version,
      cover: { path: 'images/cover.png', alt: `The ${kit.name} theme in Orca` },
      screenshots: modes.map((mode) => ({
        path: `images/${mode}.png`,
        caption: `${kit.name} in ${mode} mode`,
        theme: mode
      }))
    }).files
  } catch (error) {
    throw error instanceof ThemeStudioError
      ? new RuntimeClientError(error.code, error.message, error.data)
      : error
  }
  const images: Record<string, Buffer> = {
    'images/cover.png': Buffer.from(kit.images.cover.png, 'base64'),
    ...Object.fromEntries(
      kit.images.screenshots.map((shot) => [
        `images/${shot.mode}.png`,
        Buffer.from(shot.png, 'base64')
      ])
    )
  }
  for (const [path, body] of [...Object.entries(files), ...Object.entries(images)]) {
    const file = join(folder, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
  }
  return [...Object.keys(files), ...Object.keys(images)]
}

function publishSteps(
  folder: string,
  owner: string,
  repo: string,
  kit: PublishKit,
  version: string
): Step[] {
  const slug = `${owner}/${repo}`
  const tag = `v${version}`
  return [
    { label: 'Start a Git repository', command: ['git', 'init', '-b', 'main'], cwd: folder },
    { label: 'Add the files', command: ['git', 'add', '-A'], cwd: folder },
    {
      label: 'Commit',
      command: ['git', 'commit', '-m', `Publish ${kit.name} ${version}`],
      cwd: folder
    },
    {
      label: 'Create the public GitHub repository and push',
      command: [
        'gh',
        'repo',
        'create',
        slug,
        '--public',
        '--source',
        folder,
        '--remote',
        'origin',
        '--push',
        '--description',
        `${kit.name}: a theme for Orca`
      ]
    },
    { label: 'Tag the version', command: ['git', 'tag', '-a', tag, '-m', tag], cwd: folder },
    { label: 'Push the tag', command: ['git', 'push', 'origin', tag], cwd: folder },
    {
      label: 'Mark it as an Orca plugin',
      command: ['gh', 'repo', 'edit', slug, '--add-topic', 'orca-plugin']
    },
    {
      label: 'Cut the release',
      command: [
        'gh',
        'release',
        'create',
        tag,
        '--repo',
        slug,
        '--title',
        `${kit.name} ${version}`,
        '--notes',
        `${kit.name}, an Orca theme. Install it in Orca with: orca plugin install ${slug}`
      ]
    }
  ]
}

const shellLine = (command: string[]): string =>
  command.map((part) => (/^[\w./:@=-]+$/.test(part) ? part : JSON.stringify(part))).join(' ')

async function confirmInTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim())
  } finally {
    prompt.close()
  }
}

/**
 * `orca theme publish`: writes a validated plugin folder with images drawn from the theme, then,
 * only after the person says yes, makes it a public GitHub repository with a tagged release and
 * prints its catalog entry. Without --yes (and no terminal to ask in) it stops at the plan.
 */
export async function publishTheme(ctx: HandlerContext): Promise<void> {
  const pluginKey = stringFlag(ctx, 'plugin')
  if (!pluginKey) {
    throw new RuntimeClientError('invalid_argument', 'Missing <plugin-key>.', {
      nextSteps: [
        'Run `orca theme show --json` or look in Settings → Appearance for the saved theme.'
      ]
    })
  }
  const version = stringFlag(ctx, 'version') ?? DEFAULT_VERSION
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new RuntimeClientError('invalid_argument', '--version must look like 1.0.0.')
  }
  const kit = await call<PublishKit>(ctx, 'themeStudio.publishKit', { pluginKey })
  const folder = localPath(ctx, stringFlag(ctx, 'dir') ?? kit.id, 'publish')
  assertUsableFolder(folder, kit.id)
  const [repoOwner, repoName] = (stringFlag(ctx, 'repo') ?? '').split('/')
  const owner = repoName ? repoOwner : await githubUser()
  const repo = repoName ?? (repoOwner || `${kit.id}-orca-theme`)
  if ((owner && !OWNER_NAME.test(owner)) || !REPO_NAME.test(repo)) {
    throw new RuntimeClientError('invalid_argument', '--repo must look like owner/name.')
  }
  const files = await writeKit(folder, kit, version)
  const validation = await validatePluginTarget(folder)
  if (!validation.valid) {
    throw new RuntimeClientError(
      'plugin_invalid',
      'The theme folder does not pass `orca plugin validate`.',
      {
        errors: validation.errors,
        nextSteps: [
          `Fix the theme with \`orca theme edit --from ${pluginKey}\`, save it, and publish again.`
        ]
      }
    )
  }
  const steps = publishSteps(folder, owner ?? '<your-github-user>', repo, kit, version)
  const slug = `${owner ?? '<your-github-user>'}/${repo}`
  const plan = {
    pluginKey,
    folder,
    files,
    version,
    repository: { slug, url: `https://github.com/${slug}`, visibility: 'public' },
    steps: steps.map((step) => ({ label: step.label, command: shellLine(step.command) }))
  }
  const confirmed =
    ctx.flags.has('yes') ||
    (owner !== null &&
      !ctx.json &&
      process.stdin.isTTY === true &&
      (await confirmInTerminal(`Publish ${kit.name} publicly to github.com/${slug}?`)))
  if (!confirmed || owner === null) {
    print(
      ctx,
      {
        status: 'planned',
        ...plan,
        nextSteps: [
          ...(owner === null
            ? ['Install the GitHub CLI and run `gh auth login`, or pass --repo owner/name.']
            : []),
          'Show the user this plan: everything in the folder becomes public at the repository URL.',
          `Only after they say yes, run: orca theme publish ${pluginKey} --dir ${JSON.stringify(folder)} --repo ${slug} --yes`
        ]
      },
      [
        `Plan (nothing is published yet): ${kit.name} ${version}`,
        `  folder: ${folder} (${files.length} files, passes \`orca plugin validate\`)`,
        `  public repository: https://github.com/${slug}`,
        ...plan.steps.map((step, index) => `  ${index + 1}. ${step.label}: ${step.command}`),
        owner === null
          ? 'Sign in with `gh auth login` (or pass --repo owner/name) to publish.'
          : `Ask the user; when they agree, run it again with --yes.`
      ].join('\n')
    )
    return
  }
  const done: string[] = []
  for (const step of steps) {
    try {
      const [command, ...args] = step.command
      await run(command, args, { cwd: step.cwd, timeout: 120_000 })
      done.push(step.label)
    } catch (error) {
      throw new RuntimeClientError(
        'publish_failed',
        `${step.label} failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          done,
          failed: shellLine(step.command),
          nextSteps: [
            'Fix the cause, then run the remaining steps from this plan by hand, starting with the one that failed.'
          ]
        }
      )
    }
  }
  const entry = await validatePluginTarget(folder)
    .then(pluginReleaseEntryForFolder)
    .catch(() => null)
  print(
    ctx,
    {
      status: 'published',
      ...plan,
      releaseEntry: entry,
      install: `orca plugin install ${slug}`,
      listing: `https://orca.dev/plugins/${slug}`,
      nextSteps: [
        `Anyone can install it now with: orca plugin install ${slug}`,
        `To list it in Orca's community catalog, ask the user first, then fork ${COMMUNITY_CATALOG}, add this entry to orca-catalog.json and open a pull request: gh repo fork ${COMMUNITY_CATALOG} --clone`
      ]
    },
    [
      `Published ${kit.name} ${version} to https://github.com/${slug}`,
      ...done.map((label) => `  ✓ ${label}`),
      `Install: orca plugin install ${slug}`,
      `Listing: https://orca.dev/plugins/${slug}`,
      `To add it to the community catalog (ask the user first), open a pull request on ${COMMUNITY_CATALOG} with the release entry from \`orca plugin release-entry ${folder}\`.`
    ].join('\n')
  )
}
