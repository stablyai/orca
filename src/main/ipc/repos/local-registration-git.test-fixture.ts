import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export async function registrationGitLayout(root: string, linked: boolean) {
  const main = join(root, 'main')
  await mkdir(main, { recursive: true })
  const env = { ...process.env }
  delete env.GIT_CONFIG_COUNT
  const git = async (args: string[]) => {
    const result = await runProcess({ program: 'git', args, cwd: main, env, timeoutMs: 15_000 })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
  }
  await git(['init', '--quiet'])
  await git([
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=orca@example.invalid',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'fixture'
  ])
  const input = join(root, linked ? 'linked' : 'main/sub')
  await (linked
    ? git(['worktree', 'add', '--quiet', '-b', 'registration-linked', input])
    : mkdir(input))
  return { main, input }
}
