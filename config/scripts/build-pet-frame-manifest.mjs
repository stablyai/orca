#!/usr/bin/env node
/**
 * Precompute sprite frame rectangles for the bundled mesh-default pets.
 *
 * Why this exists: pet.json ships no frame data. The desktop discovers frames
 * at runtime by chroma-keying magenta out of the sheet and scanning pixel rows
 * and columns for gutters, using canvas ImageData. React Native has no canvas,
 * so the phone cannot do that on device.
 *
 * Rather than write a second detector for mobile — which would drift, and drift
 * here means sprites cropped at the wrong offsets — this runs THE SAME
 * shared/sprite-frame-detection and shared/pet-chroma-key the renderer uses,
 * in Node, and emits the result as JSON. Desktop and mobile then agree by
 * construction.
 *
 * Regenerate with: pnpm run build:pet-frames
 */

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const petsDir = join(repoRoot, 'resources', 'pets', 'mesh-defaults')
const outFile = join(repoRoot, 'mobile', 'src', 'pet', 'pet-frames.generated.json')

/**
 * The detection + key live in TypeScript that Node cannot import directly.
 * Bundle them to a temp ESM file rather than duplicating the logic — the whole
 * point of this script is that there is exactly one implementation.
 */
async function loadSharedModules() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-pet-frames-'))
  const outfile = join(dir, 'shared.mjs')
  await build({
    entryPoints: [join(repoRoot, 'config', 'scripts', 'pet-frame-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile).href)
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function framesForSheet(sheetPath, detectFramesFromImageData, keyMagenta) {
  const image = await loadImage(sheetPath)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  const imageData = ctx.getImageData(0, 0, image.width, image.height)
  // Key first: detection looks for transparent gutters, and an unkeyed sheet is
  // opaque magenta everywhere, which reads as one giant frame.
  keyMagenta(imageData.data)
  const detected = detectFramesFromImageData(imageData)
  return {
    width: image.width,
    height: image.height,
    frames: detected?.frames ?? []
  }
}

async function main() {
  const { mod, cleanup } = await loadSharedModules()
  try {
    const pets = readdirSync(petsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    const manifest = {}
    let failures = 0
    for (const id of pets) {
      const dir = join(petsDir, id)
      let manifestJson
      try {
        manifestJson = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
      } catch {
        console.error(`skip ${id}: unreadable pet.json`)
        failures += 1
        continue
      }
      const sheetName = manifestJson.spritesheetPath ?? 'spritesheet.webp'
      const result = await framesForSheet(
        join(dir, sheetName),
        mod.detectFramesFromImageData,
        mod.keyMagenta
      )
      if (result.frames.length === 0) {
        // Loud, not silent: a pet with no frames would render as a blank square
        // on the phone, which looks like a broken feature rather than bad data.
        console.error(`FAIL ${id}: no frames detected in ${sheetName}`)
        failures += 1
        continue
      }
      manifest[id] = {
        displayName: manifestJson.displayName ?? id,
        sheet: sheetName,
        ...result
      }
      console.log(
        `${id}: ${result.frames.length} frames (${result.width}x${result.height})`
      )
    }

    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`\nwrote ${Object.keys(manifest).length} pets -> ${outFile}`)
    if (failures > 0) {
      console.error(`${failures} pet(s) failed`)
      process.exit(1)
    }
  } finally {
    cleanup()
  }
}

await main()
