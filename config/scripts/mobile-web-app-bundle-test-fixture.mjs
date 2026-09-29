import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { bundleMobileWebApp, buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'

export async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-test-'))
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// Snapshots preserve Buffer methods and give each assertion its own mutable copy.
let appBundleSnapshot
let writtenBundleSnapshot

export async function readAppBundle() {
  appBundleSnapshot ??= bundleMobileWebApp().then(serialize)
  // Deserialized Buffers alias their snapshot, so copy it before exposing them.
  return deserialize(Buffer.from(await appBundleSnapshot))
}

export async function readWrittenBundle() {
  writtenBundleSnapshot ??= withScratch(async (scratch) => {
    const { outDir, ...result } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    const files = await Promise.all(
      ['manifest.json', ...result.manifest.assets.map((asset) => asset.path)].map(async (file) => ({
        file,
        bytes: await readFile(join(outDir, file))
      }))
    )
    return serialize({ ...result, html, files })
  })
  return deserialize(Buffer.from(await writtenBundleSnapshot))
}

export async function copyWrittenBundle(outDir) {
  const snapshot = await readWrittenBundle()
  for (const { file, bytes } of snapshot.files) {
    const destination = join(outDir, file)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  return { ...snapshot, outDir }
}
