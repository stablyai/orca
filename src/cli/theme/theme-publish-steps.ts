import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { RuntimeClientError } from '../runtime/connection/types'

const STEP_TIMEOUT_MS = 120_000

/** One publishing step; `skipIf` succeeding means it is already done (a re-run or a new version).
 *  Git commands carry `-C <folder>`, so a printed command does the same thing wherever it is run. */
export type PublishStep = {
  label: string
  command: string[]
  skipIf?: string[]
  /** Runs instead of `command` when `skipIf` succeeds. */
  otherwise?: string[]
}

/** POSIX shell quoting, so a pasted plan command never runs `$(…)` from a theme name. */
export function shellLine(command: readonly string[]): string {
  return command
    .map((part) => (/^[\w./:@=+-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

/** Runs a command without a shell; resolves with its stderr when it fails, null when it worked. */
export async function runCommand(command: readonly string[]): Promise<string | null> {
  const [program, ...args] = command
  try {
    const result = await runProcess({ program, args, timeoutMs: STEP_TIMEOUT_MS })
    if (result.code === 0) {
      return null
    }
    return result.timedOut ? 'timed out' : result.stderr.trim() || `exit code ${result.code}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const succeeds = async (command: readonly string[]): Promise<boolean> =>
  (await runCommand(command)) === null

/** Each step from the plan, safe to repeat: finished ones are skipped, so a new version or a
 *  retry after a failure picks up where it stopped. */
export function publishSteps(input: {
  folder: string
  slug: string
  name: string
  version: string
  /** Top-level names this command writes (files and folders). */
  files: string[]
}): PublishStep[] {
  const { folder, slug, name, version } = input
  const tag = `v${version}`
  const install = `orca plugin install ${slug}`
  const git = (...args: string[]): string[] => ['git', '-C', folder, ...args]
  return [
    {
      label: 'Start a Git repository',
      // Why -c rather than `init -b`: works on Git older than 2.28 too (they keep their default).
      command: git('-c', 'init.defaultBranch=main', 'init'),
      skipIf: git('rev-parse', '--git-dir')
    },
    // Why named paths: only what this command wrote is published, never a stray file.
    { label: 'Add the files', command: git('add', '-A', '--', ...input.files) },
    {
      label: 'Commit',
      // Why no signing: a signing prompt would wait unseen; this commit is the theme's own repo.
      command: git('-c', 'commit.gpgsign=false', 'commit', '-m', `Publish ${name} ${version}`),
      skipIf: git('diff', '--cached', '--quiet')
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
        `${name}: a theme for Orca`
      ],
      skipIf: ['gh', 'repo', 'view', slug, '--json', 'name'],
      otherwise: git('push', '-u', 'origin', 'HEAD')
    },
    {
      label: 'Tag the version',
      command: git('tag', '-a', tag, '-m', tag),
      skipIf: git('rev-parse', '-q', '--verify', `refs/tags/${tag}`)
    },
    { label: 'Push the tag', command: git('push', 'origin', tag) },
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
        `${name} ${version}`,
        '--notes',
        `${name}, an Orca theme. Install it in Orca with: ${install}`
      ],
      skipIf: ['gh', 'release', 'view', tag, '--repo', slug]
    }
  ]
}

/** Fails before anything public when Git cannot commit as the person. */
export async function assertGitIdentity(folder: string): Promise<void> {
  const scope = existsSync(join(folder, '.git')) ? ['-C', folder] : []
  if (!(await succeeds(['git', ...scope, 'config', 'user.email']))) {
    throw new RuntimeClientError('invalid_argument', 'Git has no user.email to commit with.', {
      nextSteps: ['Ask the user to set it: git config --global user.email "<their email>"']
    })
  }
}

/** Runs the steps in order; returns what each did, or throws with what finished and what failed. */
export async function runPublishSteps(steps: readonly PublishStep[]): Promise<string[]> {
  const done: string[] = []
  for (const step of steps) {
    const skip = step.skipIf ? await succeeds(step.skipIf) : false
    const command = skip ? step.otherwise : step.command
    if (command) {
      const failure = await runCommand(command)
      if (failure !== null) {
        throw new RuntimeClientError('publish_failed', `${step.label} failed: ${failure}`, {
          done,
          failed: shellLine(command),
          nextSteps: [
            'Fix the cause, then run the same `orca theme publish … --yes` again; finished steps are skipped.'
          ]
        })
      }
    }
    done.push(skip && !command ? `${step.label} (already done)` : step.label)
  }
  return done
}
