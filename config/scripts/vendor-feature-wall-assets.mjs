#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { FEATURE_WALL_TILES } from '../../src/shared/feature-wall-tiles.ts'
import { verifyLosslessFeatureWallMedia } from './verify-feature-wall-lossless-media.mjs'

const __dirname = import.meta.dirname
const ROOT = path.join(__dirname, '..', '..')
const DEFAULT_MARKETING_REPO = path.join(
  homedir(),
  'source',
  'repos',
  'Stably',
  'orca-marketing-website'
)
const MARKETING_REPO = process.env.ORCA_MARKETING_REPO || DEFAULT_MARKETING_REPO
const DEST_ROOT = path.join(ROOT, 'resources', 'onboarding', 'feature-wall')

const TILES = [
  {
    id: 'tile-01',
    sourceRoot: ROOT,
    gifRelativePath: 'docs/site/public/docs/tab-split.gif',
    posterRelativePath: 'docs/site/public/docs/posters/tab-split.jpg'
  },
  {
    id: 'tile-02',
    gifRelativePath: 'public/whats-new/ghostty-style-terminal.gif',
    posterRelativePath: 'public/whats-new/posters/ghostty-style-terminal.jpg'
  },
  {
    id: 'tile-03',
    gifRelativePath: 'public/whats-new/orca-github.gif',
    posterRelativePath: 'public/whats-new/posters/orca-github.jpg'
  },
  {
    id: 'tile-04',
    gifRelativePath: 'public/whats-new/any-cli-agent.gif',
    posterRelativePath: 'public/whats-new/posters/any-cli-agent.jpg'
  },
  {
    id: 'tile-05',
    gifRelativePath: 'public/whats-new/orca-design-mode.gif',
    posterRelativePath: 'public/whats-new/posters/orca-design-mode.jpg'
  },
  {
    id: 'tile-06',
    gifRelativePath: 'public/whats-new/ssh-demo.gif',
    posterRelativePath: 'public/whats-new/posters/ssh-demo.jpg'
  },
  {
    id: 'tile-07',
    gifRelativePath: 'public/file-drag.gif',
    posterRelativePath: 'public/whats-new/posters/file-drag.jpg'
  },
  {
    id: 'tile-08',
    gifRelativePath: 'public/whats-new/annotate-ai-diff.gif',
    posterRelativePath: 'public/whats-new/posters/annotate-ai-diff.jpg'
  },
  {
    id: 'tile-09',
    gifRelativePath: 'public/whats-new/orca-cli-demo.gif',
    posterRelativePath: 'public/whats-new/posters/orca-cli-demo.jpg'
  },
  {
    id: 'tile-10',
    gifRelativePath: 'public/whats-new/keyboard-native.gif',
    posterRelativePath: 'public/whats-new/posters/keyboard-native.jpg'
  },
  {
    id: 'tile-11',
    gifRelativePath: 'public/whats-new/codex-account-switcher.gif',
    posterRelativePath: 'public/whats-new/posters/codex-account-switcher.jpg'
  },
  {
    id: 'tile-12',
    gifRelativePath: 'public/whats-new/orca-markdown-editor.gif',
    posterRelativePath: 'public/whats-new/posters/orca-markdown-editor.jpg'
  }
]

function sourceRootForTile(tile) {
  return tile.sourceRoot ?? MARKETING_REPO
}

function gitRecordedAtSeconds(tile, relativePath) {
  const result = spawnSync('git', ['log', '--format=%at', '-1', '--', relativePath], {
    cwd: sourceRootForTile(tile),
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`git log failed for ${relativePath}: ${result.stderr || result.stdout}`)
  }
  const value = result.stdout.trim()
  if (!value) {
    throw new Error(`No git history found for ${relativePath}`)
  }
  return Number(value)
}

await mkdir(DEST_ROOT, { recursive: true })

const originals = new Map()
const stagingRoot = await mkdtemp(path.join(tmpdir(), 'orca-feature-wall-media-'))
try {
  for (const tile of TILES) {
    const sourceRoot = sourceRootForTile(tile)
    const sourceGif = path.join(sourceRoot, ...tile.gifRelativePath.split('/'))
    const sourcePoster = path.join(sourceRoot, ...tile.posterRelativePath.split('/'))
    const media = FEATURE_WALL_TILES.find((item) => item.id === tile.id)
    if (!media || media.kind !== 'media') {
      throw new Error(`Unknown media tile: ${tile.id}`)
    }
    const destAnimation = path.join(stagingRoot, media.gifPath)
    const destPoster = path.join(stagingRoot, `${tile.id}.poster.jpg`)
    const recordedAtSeconds = gitRecordedAtSeconds(tile, tile.gifRelativePath)

    originals.set(tile.id, await readFile(sourceGif))
    if (media.gifPath.endsWith('.gif')) {
      await copyFile(sourceGif, destAnimation)
    } else {
      // gif2webp defaults to lossless; the verifier rejects changed pixels or timing.
      const result = runProcessSync({
        program: 'gif2webp',
        args: ['-m', '6', '-min_size', '-metadata', 'all', sourceGif, '-o', destAnimation],
        timeoutMs: 120_000
      })
      if (result.code !== 0) {
        throw new Error(`gif2webp failed for ${tile.id}: ${result.stderr}`)
      }
    }
    await copyFile(sourcePoster, destPoster)
    await writeFile(
      path.join(stagingRoot, `${tile.id}.recorded-at.json`),
      `${JSON.stringify(
        {
          recordedAtUnixSeconds: recordedAtSeconds,
          recordedAtIso: new Date(recordedAtSeconds * 1000).toISOString(),
          sourceGif: tile.gifRelativePath,
          sourcePoster: tile.posterRelativePath
        },
        null,
        2
      )}\n`
    )

    console.log(`Vendored ${tile.gifRelativePath} -> ${tile.id}`)
  }

  await verifyLosslessFeatureWallMedia(originals, stagingRoot)
  for (const tile of TILES) {
    const media = FEATURE_WALL_TILES.find((item) => item.id === tile.id)
    if (media?.kind !== 'media') {
      throw new Error(`Unknown media tile: ${tile.id}`)
    }
    for (const file of [media.gifPath, media.posterPath, media.recordedAtPath]) {
      await copyFile(path.join(stagingRoot, file), path.join(DEST_ROOT, file))
    }
    if (media.gifPath.endsWith('.webp')) {
      await rm(path.join(DEST_ROOT, `${tile.id}.gif`), { force: true })
    }
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}
