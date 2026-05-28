#!/usr/bin/env node
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
    gifRelativePath: 'docs/assets/feature-wall/parallel-worktrees.gif',
    posterRelativePath: 'docs/assets/feature-wall/parallel-worktrees.jpg'
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

for (const tile of TILES) {
  const sourceRoot = sourceRootForTile(tile)
  const sourceGif = path.join(sourceRoot, ...tile.gifRelativePath.split('/'))
  const sourcePoster = path.join(sourceRoot, ...tile.posterRelativePath.split('/'))
  const destGif = path.join(DEST_ROOT, `${tile.id}.gif`)
  const destPoster = path.join(DEST_ROOT, `${tile.id}.poster.jpg`)
  const recordedAtSeconds = gitRecordedAtSeconds(tile, tile.gifRelativePath)

  await copyFile(sourceGif, destGif)
  await copyFile(sourcePoster, destPoster)
  await writeFile(
    path.join(DEST_ROOT, `${tile.id}.recorded-at.json`),
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
