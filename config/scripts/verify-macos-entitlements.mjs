#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '../..')

const defaultPlists = [
  'resources/build/entitlements.mac.plist',
  'resources/build/entitlements.computer-use.mac.plist'
]

const plistPaths = process.argv.slice(2)
const pathsToCheck = plistPaths.length > 0 ? plistPaths : defaultPlists

let failed = false

for (const plistPath of pathsToCheck) {
  const absolutePath = resolve(repoRoot, plistPath)
  const xml = readFileSync(absolutePath, 'utf8')
  const problems = findDuplicateDictKeys(xml)

  if (problems.length === 0) {
    console.log(`${plistPath}: OK`)
    continue
  }

  failed = true
  console.error(`${plistPath}: duplicate plist dict keys found`)
  for (const problem of problems) {
    console.error(
      `- ${problem.key} first appears on line ${problem.firstLine}, duplicated on line ${problem.duplicateLine}`
    )
  }
}

if (failed) {
  process.exit(1)
}

function findDuplicateDictKeys(xml) {
  const problems = []
  const lineStarts = buildLineStarts(xml)
  const dictStack = []
  // Why: `plutil -lint` accepts duplicate keys, but `codesign` rejects
  // duplicate entitlements during release signing.
  const tokenPattern =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<key\b[^>]*>([\s\S]*?)<\/key>|<(\/?)dict\b[^>]*>/g

  for (const match of xml.matchAll(tokenPattern)) {
    if (match[0].startsWith('<!--') || match[0].startsWith('<![CDATA[')) {
      continue
    }

    if (match[0].startsWith('<key')) {
      const currentDict = dictStack.at(-1)
      if (!currentDict) {
        continue
      }

      const key = decodeXmlEntities(match[1].trim())
      const duplicateLine = lineNumberForIndex(lineStarts, match.index)
      const firstLine = currentDict.keys.get(key)

      if (firstLine) {
        problems.push({ key, firstLine, duplicateLine })
      } else {
        currentDict.keys.set(key, duplicateLine)
      }
      continue
    }

    if (match[2] === '/') {
      dictStack.pop()
    } else {
      dictStack.push({ keys: new Map() })
    }
  }

  return problems
}

function buildLineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1)
    }
  }
  return starts
}

function lineNumberForIndex(lineStarts, targetIndex) {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lineStarts[mid] <= targetIndex) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return high + 1
}

function decodeXmlEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|apos|quot);/g, (entity, body) => {
    if (body === 'amp') {
      return '&'
    }
    if (body === 'lt') {
      return '<'
    }
    if (body === 'gt') {
      return '>'
    }
    if (body === 'apos') {
      return "'"
    }
    if (body === 'quot') {
      return '"'
    }
    if (body.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    }
    if (body.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    }
    return entity
  })
}
