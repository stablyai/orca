import { readFileSync } from 'node:fs'
import path from 'node:path'
import { splitPatchEntries } from './xterm-patch-text.mjs'

export function assertMappedSourcesMatch({ packageRoot, sourceRoot, sourceMaps, sourcePatch }) {
  const maps = Object.entries(sourceMaps)
  if (maps.length === 0) {
    throw new Error('Source-map verification requires at least one published map')
  }
  const changedFiles = sourcePatch === undefined ? [] : splitPatchEntries(sourcePatch)
  for (const [mapFile, prefix] of maps) {
    const map = JSON.parse(readFileSync(path.join(packageRoot, mapFile), 'utf8'))
    if (!Array.isArray(map.sources) || map.sources.length !== map.sourcesContent?.length) {
      throw new Error(`${mapFile}: missing or incomplete sourcesContent`)
    }
    const mappedFiles = new Set()
    for (let index = 0; index < map.sources.length; index++) {
      const source = map.sources[index]
      if (!source.startsWith(prefix)) {
        continue
      }
      const relative = source.slice(prefix.length)
      if (!relative.startsWith('src/') || relative.split('/').includes('..')) {
        throw new Error(`${mapFile}: unexpected mapped source ${source}`)
      }
      if (mappedFiles.has(relative)) {
        throw new Error(`${mapFile}: duplicate mapped source ${relative}`)
      }
      mappedFiles.add(relative)
      const expected = readFileSync(path.join(sourceRoot, relative), 'utf8')
      if (map.sourcesContent[index] !== expected) {
        throw new Error(`${mapFile}: mapped source does not match checkout: ${relative}`)
      }
    }
    if (mappedFiles.size === 0) {
      throw new Error(`${mapFile}: no sources match prefix ${prefix}`)
    }
    for (const entry of changedFiles) {
      if (!mappedFiles.has(entry.path)) {
        throw new Error(`${mapFile}: changed source is not shipped in the map: ${entry.path}`)
      }
    }
  }
}
