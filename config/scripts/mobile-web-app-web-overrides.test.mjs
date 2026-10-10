import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const allowlistPath = join(mobileDir, 'web-entry', 'web-overrides.json')

// Every tree the app entry can resolve a .web.* sibling out of: src and web-entry and packages
// through the builder's resolveExtensions, app through the route manifest's own sibling
// preference. packages is in the list because the dictation hook imports the vendored
// @orca/expo-two-way-audio, whose web module then reaches the page.
const SCANNED = ['src', 'app', 'web-entry', 'packages']
const WEB_SIBLING = /\.web\.(tsx|ts|jsx|js)$/

async function listFiles(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') {
      continue
    }
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFiles(entryPath)))
    } else if (entry.isFile()) {
      out.push(entryPath)
    }
  }
  return out
}

/** Takes the root so the census can be run against a scratch tree and shown to fail. */
export async function findWebSiblings(rootDir) {
  const found = []
  for (const tree of SCANNED) {
    const directory = join(rootDir, tree)
    if (!existsSync(directory)) {
      continue
    }
    for (const file of await listFiles(directory)) {
      if (WEB_SIBLING.test(file)) {
        found.push(relative(rootDir, file).split('\\').join('/'))
      }
    }
  }
  return found.sort()
}

async function readAllowlist() {
  return JSON.parse(await readFile(allowlistPath, 'utf8'))
}

async function exists(path) {
  return readFile(path).then(
    () => true,
    () => false
  )
}

async function withScratch(run) {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-overrides-'))
  try {
    return await run(scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function plant(scratch, file) {
  await mkdir(join(scratch, file, '..'), { recursive: true })
  await writeFile(join(scratch, file), 'export default null\n', 'utf8')
}

describe('mobile web app .web.* overrides', () => {
  it('lists exactly the .web.* files on disk', async () => {
    const { overrides } = await readAllowlist()
    expect(overrides.map((entry) => entry.file).sort()).toEqual(await findWebSiblings(mobileDir))
  })

  it('gives every override a non-web sibling, so the native build still has a module', async () => {
    const { overrides } = await readAllowlist()
    for (const { file } of overrides) {
      const native = join(mobileDir, file.replace('.web.', '.'))
      // A .web.tsx may shadow a .tsx or a .ts; try both before failing.
      const alternative = native.replace(/\.tsx$/, '.ts').replace(/\.jsx$/, '.js')
      expect(
        (await exists(native)) || (await exists(alternative)),
        `${file} has no non-web sibling`
      ).toBe(true)
    }
  })

  it('states a reason for every override', async () => {
    const { overrides } = await readAllowlist()
    for (const entry of overrides) {
      expect(entry.reason.length, `${entry.file} has no reason`).toBeGreaterThan(20)
    }
  })
})

// A census that scans only trees which happen to hold no .web.* file passes for the wrong reason.
// These plant one in each scanned tree and show the first assertion above would report it.
describe('the census scan', () => {
  it('reports an unlisted .web.* in every tree it claims to cover', async () => {
    const planted = {
      src: 'src/transport/planted.web.ts',
      app: 'app/h/[hostId]/edit.web.tsx',
      'web-entry': 'web-entry/planted.web.tsx',
      packages: 'packages/expo-two-way-audio/src/Planted.web.ts'
    }
    for (const [tree, file] of Object.entries(planted)) {
      await withScratch(async (scratch) => {
        await plant(scratch, file)
        expect(
          await findWebSiblings(scratch),
          `${tree} is scanned but ${file} went unseen`
        ).toEqual([file])
      })
    }
  })

  it('skips node_modules, which vendors thousands of unrelated .web.js files', async () => {
    await withScratch(async (scratch) => {
      await plant(scratch, 'packages/x/node_modules/dep/index.web.js')
      expect(await findWebSiblings(scratch)).toEqual([])
    })
  })
})
