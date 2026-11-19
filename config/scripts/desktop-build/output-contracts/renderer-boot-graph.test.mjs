import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findNodeOnlyBootPayloads } from './renderer-boot-graph.mjs'

let rendererDir

afterEach(() => {
  if (rendererDir) {
    rmSync(rendererDir, { recursive: true, force: true })
    rendererDir = undefined
  }
})

function createRendererFixture(bootScriptCode) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-renderer-boot-graph-'))
  rendererDir = dir
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="./assets/boot.js"></script></head><body></body></html>'
  )
  writeFileSync(join(dir, 'assets', 'boot.js'), bootScriptCode)
  return dir
}

describe('findNodeOnlyBootPayloads', () => {
  it('flags boot chunks containing Node-only lru-cache diagnostics_channel metrics', () => {
    const dir = createRendererFixture('const ch = channel("lru-cache:metrics");')
    expect(findNodeOnlyBootPayloads(dir)).toEqual([
      { label: 'lru-cache (node:diagnostics_channel)', chunk: 'boot.js' }
    ])
  })

  it('passes when boot chunks use the browser-safe bundle', () => {
    const dir = createRendererFixture('export const LigaturesAddon = class {};')
    expect(findNodeOnlyBootPayloads(dir)).toEqual([])
  })
})
