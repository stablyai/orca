import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { realpath, stat, writeFile } from 'node:fs/promises'

type SymlinkCleanupMarker = {
  realPath: string
  mtimeMs: number
  size: number
  contentsHash: string
}

function markerPath(configPath: string): string {
  return `${configPath}.orca-cleaned-symlink`
}

function hash(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

export async function recordGrokSymlinkCleanup(
  configPath: string,
  contents: string
): Promise<void> {
  const realPath = await realpath(configPath)
  const stats = await stat(realPath)
  const marker: SymlinkCleanupMarker = {
    realPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    contentsHash: hash(contents)
  }
  await writeFile(markerPath(configPath), `${JSON.stringify(marker)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
}

export function matchesRecordedGrokSymlinkCleanup(configPath: string, contents: string): boolean {
  try {
    const marker = JSON.parse(
      readFileSync(markerPath(configPath), 'utf8')
    ) as Partial<SymlinkCleanupMarker>
    const realPath = realpathSync(configPath)
    const stats = statSync(realPath)
    return (
      marker.realPath === realPath &&
      marker.mtimeMs === stats.mtimeMs &&
      marker.size === stats.size &&
      marker.contentsHash === hash(contents)
    )
  } catch {
    return false
  }
}

export function clearGrokSymlinkCleanupMarker(configPath: string): void {
  rmSync(markerPath(configPath), { force: true })
}
