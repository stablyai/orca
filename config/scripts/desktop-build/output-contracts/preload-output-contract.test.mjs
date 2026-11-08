import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifySandboxedMainPreloadOutputs } from './preload-output-contract.mjs'

const SANDBOX_SAFE = 'const { ipcRenderer } = require("electron");\nipcRenderer.send("ready");\n'

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Writes a fake build root whose out/main holds the given preload sources. */
async function buildRoot(files) {
  const root = await mkdtemp(join(tmpdir(), 'orca-sandboxed-main-preloads-'))
  scratch.push(root)
  await mkdir(join(root, 'out', 'main'), { recursive: true })
  for (const [fileName, source] of Object.entries(files)) {
    await writeFile(join(root, 'out', 'main', fileName), source)
  }
  return root
}

describe('sandboxed main preload outputs', () => {
  it('accepts out/main preloads that only require sandbox modules', async () => {
    const root = await buildRoot({
      'browser-guest-preload.js': SANDBOX_SAFE,
      'doc-preview-link-preload.js': SANDBOX_SAFE,
      'plugin-frame-guest-preload.js': SANDBOX_SAFE,
      'browser-extension-preload.js': SANDBOX_SAFE
    })

    await expect(verifySandboxedMainPreloadOutputs(root)).resolves.toBeUndefined()
  })

  it('names the out/main preload that requires a shared main-build chunk', async () => {
    const root = await buildRoot({
      'browser-guest-preload.js': SANDBOX_SAFE,
      'doc-preview-link-preload.js': SANDBOX_SAFE,
      'plugin-frame-guest-preload.js': SANDBOX_SAFE,
      'browser-extension-preload.js': `"use strict";\nconst runtime = require("./chunks/rolldown-runtime-ABC123.js");\n${SANDBOX_SAFE}`
    })

    await expect(verifySandboxedMainPreloadOutputs(root)).rejects.toThrow(
      'out/main/browser-extension-preload.js: Unsupported sandbox preload imports: ./chunks/rolldown-runtime-ABC123.js'
    )
  })

  it('fails when a sandboxed preload is missing from out/main', async () => {
    const root = await buildRoot({
      'browser-guest-preload.js': SANDBOX_SAFE,
      'doc-preview-link-preload.js': SANDBOX_SAFE,
      'plugin-frame-guest-preload.js': SANDBOX_SAFE
    })

    await expect(verifySandboxedMainPreloadOutputs(root)).rejects.toThrow(
      join(root, 'out', 'main', 'browser-extension-preload.js')
    )
  })
})
