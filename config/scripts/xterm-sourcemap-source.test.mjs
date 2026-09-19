import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertMappedSourcesMatch } from './xterm-sourcemap-source.mjs'

const roots = []
const widget = 'export const widget = 1;\n'
const version = "export const XTERM_VERSION = '6.0.0';\n"
const sourcePatch = 'diff --git a/src/Widget.ts b/src/Widget.ts\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-xterm-map-'))
  roots.push(root)
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'Widget.ts'), widget)
  await writeFile(path.join(root, 'src', 'Version.ts'), version)
  const map = {
    sources: ['../../src/Widget.ts', '../../src/Version.ts'],
    sourcesContent: [widget, version]
  }
  const options = {
    packageRoot: root,
    sourceRoot: root,
    sourceMaps: { 'bundle.map': '../../' },
    sourcePatch
  }
  const save = async (value = map) => {
    await writeFile(path.join(root, 'bundle.map'), JSON.stringify(value))
  }
  await save()
  return { root, map, options, save }
}

describe('xterm source-map provenance', () => {
  it('matches every mapped source byte for byte, including the unstamped version', async () => {
    const { options } = await fixture()
    expect(() => assertMappedSourcesMatch(options)).not.toThrow()
  })

  it('rejects a changed source not embedded in the shipped maps', async () => {
    const { options } = await fixture()
    expect(() =>
      assertMappedSourcesMatch({
        ...options,
        sourcePatch: `${sourcePatch}diff --git a/src/Widget.test.ts b/src/Widget.test.ts\n`
      })
    ).toThrow('changed source is not shipped')
  })

  it('checks unedited mapped files too', async () => {
    const { map, options, save } = await fixture()
    map.sourcesContent[1] = "export const XTERM_VERSION = 'wrong';\n"
    await save()
    expect(() => assertMappedSourcesMatch(options)).toThrow(
      'does not match checkout: src/Version.ts'
    )
  })

  it('requires complete embedded contents in every declared map', async () => {
    const { map, options, save } = await fixture()
    delete map.sourcesContent
    await save()
    expect(() => assertMappedSourcesMatch(options)).toThrow('missing or incomplete sourcesContent')
  })

  it('rejects an empty map policy and unmatched prefixes', async () => {
    const { options } = await fixture()
    expect(() => assertMappedSourcesMatch({ ...options, sourceMaps: {} })).toThrow('at least one')
    expect(() =>
      assertMappedSourcesMatch({
        ...options,
        sourceMaps: { 'bundle.map': 'wrong/' }
      })
    ).toThrow('no sources match prefix')
  })

  it('rejects duplicate and escaping source paths', async () => {
    const { map, options, save } = await fixture()
    map.sources.push(map.sources[0])
    map.sourcesContent.push(widget)
    await save()
    expect(() => assertMappedSourcesMatch(options)).toThrow('duplicate mapped source')
    map.sources[0] = '../../src/../Widget.ts'
    await save()
    expect(() => assertMappedSourcesMatch(options)).toThrow('unexpected mapped source')
  })

  it('requires each changed source in each declared map', async () => {
    const { root, options } = await fixture()
    await writeFile(
      path.join(root, 'second.map'),
      JSON.stringify({
        sources: ['webpack://xterm/./src/Version.ts'],
        sourcesContent: [version]
      })
    )
    expect(() =>
      assertMappedSourcesMatch({
        ...options,
        sourceMaps: { ...options.sourceMaps, 'second.map': 'webpack://xterm/./' }
      })
    ).toThrow('second.map: changed source is not shipped')
  })
})
