#!/usr/bin/env node
// Materializes the patched @xterm/addon-serialize dist of any git ref, for the
// differential serialize fuzz (src/main/daemon/serialize-grid.differential.fuzz.test.ts):
//
//   node config/scripts/build-serialize-addon-at-ref.mjs --ref origin/main --out-dir /tmp/serialize-old
//   ORCA_OLD_SERIALIZE_ADDON=<printed path> pnpm exec vitest run --config config/vitest.config.ts src/main/daemon/serialize-grid.differential.fuzz.test.ts
//
// It recovers the pristine dist by reverse-applying whichever patch produced the
// installed node_modules copy, applies the ref's patch, and checks every step
// against the blob hashes in the patches' index lines.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const PACKAGE = '@xterm/addon-serialize'
const DIST_FILE = 'lib/addon-serialize.js'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1]
  }
  if (!args.ref || !args['out-dir']) {
    throw new Error('usage: build-serialize-addon-at-ref.mjs --ref <git-ref> --out-dir <dir>')
  }
  return args
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
}

function blobHash(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

function patchFileName() {
  const name = readdirSync(path.join(REPO_ROOT, 'config', 'patches')).find(
    (file) => file.startsWith('@xterm__addon-serialize@') && file.endsWith('.patch')
  )
  if (!name) {
    throw new Error('no @xterm/addon-serialize dist patch under config/patches')
  }
  return name
}

/** Pre- and post-image blob hashes the patch records for the dist file. */
function distHashes(patchText) {
  const match = patchText.match(
    new RegExp(`diff --git a/${DIST_FILE} b/${DIST_FILE}\\nindex ([0-9a-f]+)\\.\\.([0-9a-f]+)`)
  )
  if (!match) {
    throw new Error(`patch does not touch ${DIST_FILE}`)
  }
  return { pristine: match[1], patched: match[2] }
}

function applyPatch(packageDir, patchPath, reverse) {
  // Ceiling stops git from discovering an enclosing repository, so paths stay package-relative.
  git(['apply', ...(reverse ? ['-R'] : []), `--include=${DIST_FILE}`, patchPath], {
    cwd: packageDir,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(packageDir) }
  })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(args['out-dir'])
  const name = patchFileName()
  const relativePatch = path.posix.join('config', 'patches', name)
  const refPatch = git(['show', `${args.ref}:${relativePatch}`], { cwd: REPO_ROOT })
  const target = distHashes(refPatch)

  const packageDir = path.join(outDir, 'package')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  const installed = path.join(REPO_ROOT, 'node_modules', PACKAGE, DIST_FILE)
  cpSync(installed, path.join(packageDir, DIST_FILE))
  const distPath = path.join(packageDir, DIST_FILE)
  const installedHash = blobHash(readFileSync(distPath))

  if (installedHash !== target.patched) {
    const candidates = [
      readFileSync(path.join(REPO_ROOT, relativePatch), 'utf8'),
      git(['show', `HEAD:${relativePatch}`], { cwd: REPO_ROOT })
    ]
    const source = candidates.find((text) => distHashes(text).patched === installedHash)
    if (!source) {
      throw new Error(
        `installed ${DIST_FILE} (${installedHash}) matches neither the working-tree nor the HEAD patch; run pnpm install`
      )
    }
    const sourcePath = path.join(outDir, 'installed.patch')
    writeFileSync(sourcePath, source)
    applyPatch(packageDir, sourcePath, true)
    if (blobHash(readFileSync(distPath)) !== target.pristine) {
      throw new Error(`reverse-applied dist is not the pristine ${target.pristine} the ref patches`)
    }
    const refPatchPath = path.join(outDir, 'ref.patch')
    writeFileSync(refPatchPath, refPatch)
    applyPatch(packageDir, refPatchPath, false)
  }
  const finalHash = blobHash(readFileSync(distPath))
  if (finalHash !== target.patched || !existsSync(distPath)) {
    throw new Error(
      `built ${DIST_FILE} hashes to ${finalHash}, the ref patch expects ${target.patched}`
    )
  }
  process.stdout.write(`${distPath}\n`)
}

main()
