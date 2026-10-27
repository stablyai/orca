import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { reclaimWorktreeSpace } from './reclaim-worktree-space.mjs'

export function parseReclaimArguments(args) {
  const options = { apply: false, automatic: false, testsStopped: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--apply') {
      options.apply = true
    } else if (argument === '--automatic') {
      options.automatic = true
    } else if (argument === '--tests-stopped') {
      options.testsStopped = true
    } else if (argument === '--help' || argument === '-h') {
      options.help = true
    } else if (
      argument === '--repo' ||
      argument === '--release-cache-min-age-days' ||
      argument === '--generated-min-age-days' ||
      argument === '--exclude-worktree'
    ) {
      const value = args[++index]
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a value`)
      }
      if (argument === '--repo') {
        options.repoRoot = resolve(value)
      } else if (argument === '--exclude-worktree') {
        options.excludeWorktree = resolve(value)
      } else {
        const key =
          argument === '--generated-min-age-days' ? 'generatedMinAgeDays' : 'releaseCacheMinAgeDays'
        options[key] = Number(value)
        if (!Number.isFinite(options[key]) || options[key] < 0) {
          throw new Error(`${argument} requires a non-negative number`)
        }
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

export async function runReclaimCommand(
  args,
  { input = process.stdin, output = process.stdout, reclaim = reclaimWorktreeSpace } = {}
) {
  const options = parseReclaimArguments(args)
  if (options.help) {
    output.write(
      'Usage: pnpm reclaim-space [--apply] [--repo DIRECTORY] [--tests-stopped] [--release-cache-min-age-days 30] [--generated-min-age-days 30]\n'
    )
    output.write(
      'Shares Electron installs and removes idle dev bundles and Vite caches unused for 30 days across local Git worktrees.\n'
    )
    output.write('Without --apply, previews cleanup and offers [y/N] in an interactive terminal.\n')
    output.write(
      'Add --tests-stopped to include old test caches after stopping cross-version tests.\n'
    )
    output.write(
      'Cleanup includes old ignored dependencies and build output in sibling worktrees, including during automatic dev cleanup. Shared pnpm stores are retained.\n'
    )
    return
  }
  if (!options.testsStopped && !options.automatic) {
    output.write(
      'Historical test caches retained. Add --tests-stopped after stopping cross-version tests to include them.\n'
    )
  }
  if (!options.automatic) {
    output.write(
      'Cleanup includes old dependency installs and build output in sibling worktrees. Shared pnpm stores are retained.\n'
    )
  }
  await reclaim(options)
  if (options.apply || options.automatic || !input.isTTY || !output.isTTY) {
    return
  }

  const prompt = createInterface({ input, output })
  try {
    const answer = await prompt.question('Apply this cleanup? [y/N] ')
    if (/^y(?:es)?$/i.test(answer.trim())) {
      await reclaim({ ...options, apply: true })
    }
  } finally {
    prompt.close()
  }
}
