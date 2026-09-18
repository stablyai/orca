import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const allowlistPath = join(mobileDir, 'web-entry', 'web-overrides.json')

// The trees the builder's resolveExtensions covers. mobile/packages is a vendored Expo module
// with its own web build; the app entry never resolves into it through a .web.* sibling.
const SCANNED = ['src', 'app', 'web-entry']
const WEB_SIBLING = /\.web\.(tsx|ts|jsx|js)$/

async function listFiles(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFiles(entryPath)))
    } else if (entry.isFile()) {
      out.push(entryPath)
    }
  }
  return out
}

async function findWebSiblings() {
  const found = []
  for (const tree of SCANNED) {
    for (const file of await listFiles(join(mobileDir, tree))) {
      if (WEB_SIBLING.test(file)) {
        found.push(relative(mobileDir, file).split('\\').join('/'))
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

describe('mobile web app .web.* overrides', () => {
  it('lists exactly the .web.* files on disk', async () => {
    const { overrides } = await readAllowlist()
    expect(overrides.map((entry) => entry.file).sort()).toEqual(await findWebSiblings())
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
