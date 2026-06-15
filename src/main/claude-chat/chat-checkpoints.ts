import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type GitRunner = (
  args: string[],
  opts: { cwd: string; env?: Record<string, string> }
) => Promise<{ stdout: string; exitCode: number }>

export type Checkpoint = {
  sha: string
  createdAt: string
  label: string
}

export class ChatCheckpoints {
  constructor(private readonly run: GitRunner) {}

  async snapshot(cwd: string, label: string): Promise<Checkpoint | null> {
    const tmpIndex = join(tmpdir(), `orca-chat-index-${randomUUID()}`)
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex } as Record<string, string>

    try {
      // Stage all files into a throwaway index without touching the user's index
      const addResult = await this.run(['add', '-A'], { cwd, env })
      if (addResult.exitCode !== 0) {
        return null
      }

      const treeResult = await this.run(['write-tree'], { cwd, env })
      if (treeResult.exitCode !== 0) {
        return null
      }
      const treeSha = treeResult.stdout.trim()

      // Build commit-tree args; attach to HEAD if it exists
      const commitTreeArgs = ['commit-tree', treeSha, '-m', 'orca-chat checkpoint']
      const headResult = await this.run(['rev-parse', 'HEAD'], { cwd })
      if (headResult.exitCode === 0) {
        const headSha = headResult.stdout.trim()
        if (headSha.length > 0) {
          commitTreeArgs.push('-p', headSha)
        }
      }

      const commitResult = await this.run(commitTreeArgs, { cwd })
      if (commitResult.exitCode !== 0) {
        return null
      }
      const commitSha = commitResult.stdout.trim()

      // Store ref so the commit survives GC
      const refName = `refs/orca-chat/${commitSha.slice(0, 12)}`
      const updateRefResult = await this.run(['update-ref', refName, commitSha], { cwd })
      if (updateRefResult.exitCode !== 0) {
        return null
      }

      const createdAt = new Date().toISOString()
      return { sha: commitSha, createdAt, label }
    } catch {
      return null
    } finally {
      // Best-effort cleanup of temp index
      try {
        const { unlinkSync } = require('node:fs') as { unlinkSync: (p: string) => void }
        unlinkSync(tmpIndex)
      } catch {
        // ignore
      }
    }
  }

  async revert(cwd: string, sha: string): Promise<boolean> {
    const result = await this.run(['restore', '--worktree', `--source=${sha}`, '--', '.'], { cwd })
    return result.exitCode === 0
  }

  async changedFiles(cwd: string, sha: string): Promise<{ status: string; path: string }[]> {
    const result = await this.run(['diff', '--name-status', sha], { cwd })
    if (result.exitCode !== 0) {
      return []
    }
    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0)
    const files: { status: string; path: string }[] = []
    for (const line of lines) {
      const parts = line.split('\t')
      if (parts.length < 2) {
        continue
      }
      const rawStatus = parts[0]
      if (rawStatus.startsWith('R')) {
        // Rename: R100\told\tnew — use new path, status 'R'
        const newPath = parts[2] ?? parts[1]
        files.push({ status: 'R', path: newPath })
      } else {
        files.push({ status: rawStatus, path: parts[1] })
      }
    }
    return files
  }
}

// Production runner using child_process.execFile
// Imported lazily so tests never pull in child_process at module evaluation time.
export function execGitRunner(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> }
): Promise<{ stdout: string; exitCode: number }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require('node:child_process') as {
    execFile: (
      cmd: string,
      args: string[],
      opts: object,
      cb: (err: unknown, stdout: string, stderr: string) => void
    ) => void
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env },
      (err, stdout, _stderr) => {
        if (err) {
          const exitCode = (err as Record<string, unknown> & { code?: number }).code ?? 1
          resolve({ stdout: stdout ?? '', exitCode: typeof exitCode === 'number' ? exitCode : 1 })
        } else {
          resolve({ stdout, exitCode: 0 })
        }
      }
    )
  })
}
