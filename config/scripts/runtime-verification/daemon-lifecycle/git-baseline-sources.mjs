import { runProcessSync } from '@orca/process-host'
import { dirname, resolve } from 'node:path'

export function readGitBaselineSources(repo, ref, sources) {
  const historicalPaths = new Map(
    [...sources].map(([current, historical]) => [current, historical.slice(ref.length + 1)])
  )
  const candidates = [...historicalPaths].flatMap(([current, historical]) => [current, historical])
  const read = (args, maxOutputBytes) => {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd: repo,
      timeoutMs: 10_000,
      maxOutputBytes,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    if (result.code !== 0 || result.outputTruncated) {
      throw new Error(`Cannot read pinned Git baseline sources: ${result.stderr}`)
    }
    return result.stdout
  }
  const available = new Set(
    read(['ls-tree', '--name-only', ref, '--', ...candidates], 64 * 1024)
      .trim()
      .split('\n')
  )
  return new Map(
    [...historicalPaths].map(([current, historical]) => {
      const source = available.has(current)
        ? current
        : available.has(historical)
          ? historical
          : null
      if (!source) {
        throw new Error(`Pinned Git baseline source is absent: ${ref}:${current}`)
      }
      return [
        resolve(repo, current),
        {
          contents: read(['show', `${ref}:${source}`], 16 * 1024 * 1024),
          resolveDir: dirname(resolve(repo, source))
        }
      ]
    })
  )
}
