// One JSON asset per channel release that running apps download from a fixed URL, updated in place.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Bytes, not text, so a promoted asset is copied exactly. */
export function runGh(args) {
  const result = spawnSync('gh', args, { maxBuffer: 64 * 1024 * 1024 })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr?.toString('utf8') ?? ''
  }
}

export function ghOrThrow(gh, args) {
  const result = gh(args)
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** The asset on `tag`'s release as a Buffer, or null when there is no release yet. */
export function downloadChannelAsset({ gh, repo, tag, asset }) {
  const args = ['release', 'download', tag, '--repo', repo, '-p', asset, '-O', '-']
  const result = gh(args)
  if (result.status === 0) {
    return Buffer.from(result.stdout)
  }
  // Why throw on anything else, a missing asset included: that means an earlier upload broke.
  if (/release not found/i.test(result.stderr)) {
    return null
  }
  throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim()}`)
}

/**
 * Puts `bytes` on `tag`'s release, creating it as a prerelease that never becomes Latest (the app
 * updater follows Latest) when `exists` is false.
 */
export function putChannelAsset({ gh, repo, tag, asset, bytes, exists, target, title, notes }) {
  const file = join(mkdtempSync(join(tmpdir(), 'channel-release-asset-')), asset)
  writeFileSync(file, bytes)
  if (!exists) {
    ghOrThrow(gh, [
      'release',
      'create',
      tag,
      file,
      '--repo',
      repo,
      '--target',
      target,
      '--prerelease',
      '--latest=false',
      '--title',
      title,
      '--notes',
      notes
    ])
    return
  }
  // Keep fixed channel URL with --clobber; mid-upload 404 retains the app’s last good copy.
  ghOrThrow(gh, ['release', 'upload', tag, file, '--repo', repo, '--clobber'])
}
