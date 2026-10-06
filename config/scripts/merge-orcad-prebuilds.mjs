#!/usr/bin/env node
/**
 * Merge per-runner `out/orcad-prebuilds` trees into one matrix, as release CI collects them.
 * Each CI lane builds only its own slot (build-orcad-prebuilds.mjs), so the desktop template
 * build needs their union before `--require-slots` can pass.
 *
 * Usage: node config/scripts/merge-orcad-prebuilds.mjs [--out <dir>] <tree> [<tree> ...]
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { findSlotProblems, mergeManifest, readManifest } from './orcad-prebuild-slot-contents.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** Copies every verified slot from `sourceDirs` into a fresh `outDir`; returns the merged manifest. */
export function mergeOrcadPrebuildTrees(sourceDirs, outDir) {
  if (sourceDirs.length === 0) {
    throw new Error('[merge-orcad-prebuilds] no prebuild trees to merge')
  }
  if (sourceDirs.some((dir) => resolve(dir) === resolve(outDir))) {
    throw new Error(`[merge-orcad-prebuilds] ${outDir} is both a source and the output`)
  }
  const sources = sourceDirs.map((dir) => {
    const manifest = readManifest(dir)
    const slots = Object.keys(manifest?.slots ?? {})
    if (slots.length === 0) {
      throw new Error(`[merge-orcad-prebuilds] ${dir} holds no prebuild slot manifest`)
    }
    const problems = findSlotProblems(manifest, dir, slots)
    if (problems.length > 0) {
      throw new Error(`[merge-orcad-prebuilds] ${dir}: ${problems.join('; ')}`)
    }
    return { dir, manifest, slots }
  })
  // Why before any copy: a refused merge must not leave a half-built matrix behind.
  const owners = new Map()
  for (const { dir, manifest, slots } of sources) {
    if (manifest.nodeHeaders !== sources[0].manifest.nodeHeaders) {
      throw new Error(
        `[merge-orcad-prebuilds] ${dir} was built against Node ${manifest.nodeHeaders} headers, ` +
          `${sources[0].dir} against ${sources[0].manifest.nodeHeaders}`
      )
    }
    for (const slot of slots) {
      if (owners.has(slot)) {
        throw new Error(
          `[merge-orcad-prebuilds] ${slot} appears in both ${owners.get(slot)} and ${dir}`
        )
      }
      owners.set(slot, dir)
    }
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  let merged = null
  for (const { dir, manifest, slots } of sources) {
    for (const slot of slots) {
      cpSync(join(dir, slot), join(outDir, slot), { recursive: true })
      merged = mergeManifest(merged, {
        slot,
        version: manifest.version,
        napi: manifest.napi,
        nodeHeaders: manifest.nodeHeaders,
        entry: manifest.slots[slot]
      })
    }
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(merged, null, 2)}\n`)
  const problems = findSlotProblems(merged, outDir, [...owners.keys()])
  if (problems.length > 0) {
    throw new Error(`[merge-orcad-prebuilds] merged matrix: ${problems.join('; ')}`)
  }
  return merged
}

function parseArgs(argv) {
  const sources = []
  let outDir = join(ROOT, 'out', 'orcad-prebuilds')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      const value = argv[(index += 1)]
      if (!value) {
        throw new Error('[merge-orcad-prebuilds] --out needs a directory')
      }
      outDir = resolve(value)
    } else {
      sources.push(resolve(argv[index]))
    }
  }
  return { sources, outDir }
}

if (process.argv[1]?.endsWith('merge-orcad-prebuilds.mjs')) {
  const { sources, outDir } = parseArgs(process.argv.slice(2))
  const merged = mergeOrcadPrebuildTrees(sources, outDir)
  console.log(
    `[merge-orcad-prebuilds] ${outDir}: node-pty ${merged.version}, N-API ${merged.napi}, ` +
      `slots ${Object.keys(merged.slots).join(', ')}`
  )
}
