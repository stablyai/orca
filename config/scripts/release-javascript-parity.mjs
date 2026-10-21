import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const ASSET_PATH = /^(?:renderer|web)\/assets\/(.+)-[\w-]{8}\.(js|css|svg)$/
const TEXT_FILE = /\.(?:js|css|html|json|svg)$/
const NATIVE_COLOR = /color\(display-p3 ([^)]+)\)|(?<![\w-])lab\(([^)]+)\)/g

function createAssetReferenceNormalizer(replacements) {
  const references = new RegExp(
    [...replacements.keys()].map((name) => name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('|') ||
      '(?!)',
    'g'
  )
  return (content) => content.replace(references, (name) => replacements.get(name) ?? name)
}

export function normalizeManifestSourcePaths(value) {
  if (typeof value === 'string') {
    return value.replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//g, 'node_modules/')
  }
  if (Array.isArray(value)) {
    return value.map(normalizeManifestSourcePaths)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const entries = Object.entries(value)
    .map(([key, child]) => [normalizeManifestSourcePaths(key), normalizeManifestSourcePaths(child)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  assert.equal(
    new Set(entries.map(([key]) => key)).size,
    entries.length,
    'Ambiguous manifest source paths'
  )
  return Object.fromEntries(entries)
}

export function annotateJavascriptParityFiles(root, files) {
  const names = new Map()
  for (const file of files) {
    const match = file.path.match(ASSET_PATH)
    if (match) {
      const stem = `${match[1]}.${match[2]}`
      const entries = names.get(stem) ?? new Set()
      entries.add(basename(file.path))
      names.set(stem, entries)
    }
  }
  const replacements = new Map(
    [...names]
      .filter(([, entries]) => entries.size === 1)
      .map(([stem, entries]) => [[...entries][0], stem])
  )
  const contents = new Map(
    files
      .filter((file) => TEXT_FILE.test(file.path))
      .map((file) => [
        file.path,
        readFileSync(join(root, file.path), 'utf8').replaceAll('\r\n', '\n')
      ])
  )
  const normalizeIdentity = createAssetReferenceNormalizer(
    new Map([...names].flatMap(([stem, entries]) => [...entries].map((name) => [name, stem])))
  )
  const ambiguous = []
  for (const [stem, entries] of names) {
    if (entries.size < 2) {
      continue
    }
    for (const name of entries) {
      const file = files.find((file) => ASSET_PATH.test(file.path) && basename(file.path) === name)
      // Dependency hashes identify the module; final checks preserve every resolved reference.
      const signature = createHash('sha256')
        .update(normalizeIdentity(contents.get(file.path)))
        .digest('hex')
      const extension = stem.slice(stem.lastIndexOf('.'))
      ambiguous.push([name, `${stem.slice(0, -extension.length)}-${signature}${extension}`])
    }
  }
  const aliases = new Map([...replacements, ...ambiguous])
  const normalizeReferences = createAssetReferenceNormalizer(aliases)
  return files.map((file) => {
    const name = basename(file.path)
    const comparablePath = aliases.has(name)
      ? file.path.slice(0, -name.length) + aliases.get(name)
      : file.path
    if (!contents.has(file.path)) {
      return { ...file, comparablePath, comparableSha256: file.sha256 }
    }
    let content = normalizeReferences(contents.get(file.path))
    const manifest = file.path === 'renderer/.vite/manifest.json'
    if (manifest) {
      content = JSON.stringify(normalizeManifestSourcePaths(JSON.parse(content)))
    }
    return {
      ...file,
      comparablePath,
      comparableSha256: createHash('sha256').update(content).digest('hex'),
      ...(file.path.endsWith('.css') ? { css: content } : {}),
      ...(manifest ? { manifest: content } : {}),
      ...(/(?:\/assets\/(?:App|Settings|ghostty|shell-icons)-.*\.js|\/[^/]+\.html)$/.test(file.path)
        ? { text: content }
        : {})
    }
  })
}

export function equivalentStylesheets(before, after) {
  const beforeColors = [...before.matchAll(NATIVE_COLOR)]
  const afterColors = [...after.matchAll(NATIVE_COLOR)]
  const marker = (color) => (color.startsWith('lab(') ? 'NATIVE_LAB' : 'NATIVE_P3')
  if (before.replace(NATIVE_COLOR, marker) !== after.replace(NATIVE_COLOR, marker)) {
    return false
  }
  if (beforeColors.length !== afterColors.length) {
    return false
  }
  return beforeColors.every((color, index) => {
    const left = (color[1] ?? color[2]).split(/\s+/)
    const right = (afterColors[index][1] ?? afterColors[index][2]).split(/\s+/)
    const tolerance = color[1] ? 0.00000101 : 0.00010001
    return (
      left.length === right.length &&
      left.every((value, channel) => {
        if (value === right[channel]) {
          return true
        }
        // Native CSS color conversion differs by one printed decimal unit across hosts.
        return (
          /^-?(?:\d*\.)?\d+%?$/.test(value) &&
          /^-?(?:\d*\.)?\d+%?$/.test(right[channel]) &&
          value.endsWith('%') === right[channel].endsWith('%') &&
          Math.abs(Number.parseFloat(value) - Number.parseFloat(right[channel])) <= tolerance
        )
      })
    )
  })
}

export function compareJavascriptParityFiles(before, after) {
  const reference = new Map(before.map((file) => [file.comparablePath, file]))
  const candidate = new Map(after.map((file) => [file.comparablePath, file]))
  assert.equal(reference.size, before.length, 'Ambiguous baseline output paths')
  assert.equal(candidate.size, after.length, 'Ambiguous shared output paths')
  const changed = [...new Set([...reference.keys(), ...candidate.keys()])].filter((path) => {
    const left = reference.get(path)
    const right = candidate.get(path)
    if (!left || !right) {
      return true
    }
    if (left.comparableSha256 === right.comparableSha256) {
      return false
    }
    if (left.manifest && right.manifest) {
      return (
        JSON.stringify(normalizeManifestSourcePaths(JSON.parse(left.manifest))) !==
        JSON.stringify(normalizeManifestSourcePaths(JSON.parse(right.manifest)))
      )
    }
    return !left.css || !right.css || !equivalentStylesheets(left.css, right.css)
  })
  return changed
}
