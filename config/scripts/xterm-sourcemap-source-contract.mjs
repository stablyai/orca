import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { splitPatchEntries } from './xterm-patch-text.mjs'

function mappedSourcePath(source) {
  return source.match(/^(?:webpack:\/\/@xterm\/xterm\/\.\/|\.\.\/\.\.\/)(src\/.+)$/)?.[1]
}

export function mappedSourceFiles(map) {
  const files = new Map()
  for (const [index, source] of map.sources.entries()) {
    const relative = mappedSourcePath(source)
    if (!relative) {
      continue
    }
    if (relative.split('/').includes('..')) {
      throw new Error(`Unsafe mapped source: ${relative}`)
    }
    if (files.has(relative)) {
      throw new Error(`Duplicate mapped source: ${relative}`)
    }
    if (typeof map.sourcesContent[index] !== 'string') {
      throw new Error(`Missing mapped content: ${relative}`)
    }
    files.set(relative, map.sourcesContent[index])
  }
  if (files.size === 0) {
    throw new Error('Published source map contains no upstream sources')
  }
  return files
}

// Headless publishes source only inside its map; require exact-byte provenance.
export function assertMappedSourcesMatch(mapPath, checkoutRoot) {
  const files = mappedSourceFiles(JSON.parse(readFileSync(mapPath, 'utf8')))
  for (const [relative, content] of files) {
    if (readFileSync(path.join(checkoutRoot, relative), 'utf8') !== content) {
      throw new Error(`Mapped source differs from pinned checkout: ${relative}`)
    }
  }
}

export function assertMappedPatchDerivation(sourcePatch, generatedPatch, sourceMap) {
  const entry = splitPatchEntries(generatedPatch).find((entry) => entry.path === sourceMap)
  const readSide = (sign) => {
    const lines = entry?.text.split('\n') ?? []
    const hunks = lines.filter((line) => line.startsWith('@@'))
    if (hunks.length !== 1 || !/^@@ -1(?:,\d+)? \+1(?:,\d+)? @@/.test(hunks[0])) {
      throw new Error(`Source map patch must contain one complete JSON hunk: ${sourceMap}`)
    }
    const body = lines
      .slice(lines.indexOf(hunks[0]) + 1)
      .filter((line) => line.startsWith(sign) || line.startsWith(' '))
      .map((line) => line.slice(1))
      .join('\n')
    return JSON.parse(body)
  }
  const beforeMap = readSide('-'),
    afterMap = readSide('+')
  if (JSON.stringify(beforeMap.sources) !== JSON.stringify(afterMap.sources)) {
    throw new Error('Source map source names changed')
  }
  const before = mappedSourceFiles(beforeMap),
    after = mappedSourceFiles(afterMap)
  for (const [index, source] of beforeMap.sources.entries()) {
    if (
      !mappedSourcePath(source) &&
      beforeMap.sourcesContent[index] !== afterMap.sourcesContent[index]
    ) {
      throw new Error(`Unrecognized mapped source changed: ${source}`)
    }
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'orca-xterm-mapped-source-'))
  try {
    for (const [relative, content] of before) {
      mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true })
      writeFileSync(path.join(directory, relative), content)
    }
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: directory,
      input: sourcePatch,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    for (const entry of splitPatchEntries(sourcePatch)) {
      if (!after.has(entry.path)) {
        throw new Error(`Changed source missing from generated map: ${entry.path}`)
      }
    }
    if (before.size !== after.size) {
      throw new Error('Source map source set changed')
    }
    for (const [relative, content] of after) {
      if (readFileSync(path.join(directory, relative), 'utf8') !== content) {
        throw new Error(`Source patch and generated map disagree: ${relative}`)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
