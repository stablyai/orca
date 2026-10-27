#!/usr/bin/env node
// Materialize a ref’s patched serialize dist for serialize-grid.differential.fuzz.test.ts.
// Read version/patch from that ref; reverse installed patch or fetch matching pristine npm tarball, checking patch blob hashes.
// Usage: --ref <ref> --out-dir <dir>; pass printed path as ORCA_OLD_SERIALIZE_ADDON to the fuzz test.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchPristinePackage } from './regenerate-xterm-patches.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const PACKAGE = '@xterm/addon-serialize'
const DIST_FILE = 'lib/addon-serialize.js'
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

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

/** The serialize version and repo-relative patch path from a pnpm-workspace.yaml's patchedDependencies. */
function serializePatchEntry(workspaceYaml) {
  const match = workspaceYaml.match(
    /^\s+'?@xterm\/addon-serialize@([^'\s:]+)'?\s*:\s*['"]?([^'"\s]+)['"]?\s*$/m
  )
  if (!match) {
    throw new Error(`no ${PACKAGE} entry under patchedDependencies in ${WORKSPACE_FILE}`)
  }
  return { version: match[1], patchPath: match[2] }
}

/** Reads the serialize patch pinned at `ref`, or in the working tree when `ref` is null. */
function readPatchAt(ref) {
  const read = (file) =>
    ref === null
      ? readFileSync(path.join(REPO_ROOT, file), 'utf8')
      : git(['show', `${ref}:${file}`], { cwd: REPO_ROOT })
  const entry = serializePatchEntry(read(WORKSPACE_FILE))
  return { ...entry, text: read(entry.patchPath) }
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

/** Recovers the pristine dist into packageDir by reverse-applying the installed copy's patch; false if it can't. */
function recoverPristineFromInstalled(packageDir, outDir, installedHash, pristineHash) {
  const candidates = [readPatchAt(null), readPatchAt('HEAD')]
  const source = candidates.find((patch) => distHashes(patch.text).patched === installedHash)
  if (!source || distHashes(source.text).pristine !== pristineHash) {
    return false
  }
  const sourcePath = path.join(outDir, 'installed.patch')
  writeFileSync(sourcePath, source.text)
  applyPatch(packageDir, sourcePath, true)
  return true
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(args['out-dir'])
  const refPatch = readPatchAt(args.ref)
  const target = distHashes(refPatch.text)

  const packageDir = path.join(outDir, 'package')
  const distPath = path.join(packageDir, DIST_FILE)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  cpSync(path.join(REPO_ROOT, 'node_modules', PACKAGE, DIST_FILE), distPath)
  const installedHash = blobHash(readFileSync(distPath))

  if (installedHash !== target.patched) {
    if (!recoverPristineFromInstalled(packageDir, outDir, installedHash, target.pristine)) {
      const pristineDir = fetchPristinePackage({ name: PACKAGE, version: refPatch.version }, outDir)
      cpSync(path.join(pristineDir, DIST_FILE), distPath)
    }
    const pristineHash = blobHash(readFileSync(distPath))
    if (pristineHash !== target.pristine) {
      throw new Error(
        `pristine ${PACKAGE}@${refPatch.version} ${DIST_FILE} hashes to ${pristineHash}, the ref patch expects ${target.pristine}`
      )
    }
    const refPatchPath = path.join(outDir, 'ref.patch')
    writeFileSync(refPatchPath, refPatch.text)
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

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main()
}
