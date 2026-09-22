import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  bootGraphForbiddenPayloads,
  findForbiddenBootPayloads,
  prunedAwayEnglishSignature,
  readRendererBootGraph,
  RENDERER_BUILD_DIR
} from './renderer-boot-graph.mjs'

const rendererDir = path.join(process.cwd(), RENDERER_BUILD_DIR)
const built = fs.existsSync(path.join(rendererDir, 'index.html'))

describe('renderer boot graph', () => {
  it('derives an English probe the runtime-required catalog does not ship', () => {
    const signature = prunedAwayEnglishSignature()
    const runtimeRequired = fs.readFileSync(
      'src/renderer/src/i18n/en-runtime-required.json',
      'utf8'
    )
    const full = fs.readFileSync('src/renderer/src/i18n/locales/en.json', 'utf8')

    expect(full).toContain(JSON.stringify(signature).slice(1, -1))
    expect(runtimeRequired).not.toContain(JSON.stringify(signature).slice(1, -1))
  })

  // Requires `pnpm run build:electron-vite`; the same check runs unconditionally
  // at the end of that build, so CI can never skip it.
  it.runIf(built)('preloads none of the deferred payloads before first paint', () => {
    expect(findForbiddenBootPayloads(rendererDir, bootGraphForbiddenPayloads())).toEqual([])
  })

  it.runIf(built)('reads the entry chunk plus its modulepreload graph', () => {
    const { chunks, totalBytes } = readRendererBootGraph(rendererDir)

    expect(chunks.length).toBeGreaterThan(10)
    expect(totalBytes).toBeGreaterThan(0)
  })
})
