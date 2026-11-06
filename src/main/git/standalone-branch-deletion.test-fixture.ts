import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export async function runDisposableGit(directory: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

export async function createStandaloneBranchRepo() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-standalone-delete-'))
  const git = (...args: string[]) => runDisposableGit(directory, ...args)
  await git('init', '-q')
  await git('symbolic-ref', 'HEAD', 'refs/heads/main')
  await git('config', 'user.name', 'Branch deletion test')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', '')
  await writeFile(join(directory, 'file.txt'), 'base\n')
  await git('add', 'file.txt')
  await git('commit', '-qm', 'base')
  await git('branch', 'feature')
  await git('checkout', '-q', 'feature')
  await writeFile(join(directory, 'feature.txt'), 'integrated work\n')
  await git('add', 'feature.txt')
  await git('commit', '-qm', 'feature')
  const oid = await git('rev-parse', 'HEAD')
  await git('checkout', '-q', 'main')
  await git('merge', '--no-ff', '-qm', 'integrate feature', 'feature')
  const anchorOid = await git('rev-parse', 'HEAD')
  await git('remote', 'add', 'upstream', 'https://example.test/team/project.git')
  await git('update-ref', 'refs/remotes/upstream/main', anchorOid)
  await git('symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main')
  const request = {
    ref: 'refs/heads/feature',
    expectedOid: oid,
    anchorRef: 'refs/remotes/upstream/main',
    anchorOid
  }
  return { directory, request }
}
