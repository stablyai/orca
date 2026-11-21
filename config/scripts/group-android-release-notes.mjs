#!/usr/bin/env node

// Groups GitHub's generate-notes output for the Android release workflow the same
// way desktop release notes are organized into sections: by conventional-commit
// prefix first (feat / fix / perf / refactor / test / docs / chore / ci / build),
// then by scope within the prefix. Entries without a recognized prefix keep a
// catch-all section so nothing is dropped.

import { pathToFileURL } from 'node:url'

const PREFIX_SECTIONS = [
  ['feat', 'New features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['test', 'Tests'],
  ['docs', 'Documentation'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['chore', 'Maintenance']
]

const OTHER_SECTION = 'Other changes'
const LINE_PREFIX = /^[-*]\s+/
const TITLE_PREFIX = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*/i

function titleOf(line) {
  const match = /^[-*]\s+(.+?)\s+by\s+@/i.exec(line)
  return match ? match[1] : line
}

function groupKey(title) {
  const match = TITLE_PREFIX.exec(title)
  if (!match) {
    return null
  }
  const prefix = match[1].toLowerCase()
  const scope = match[2]?.toLowerCase() ?? ''
  return PREFIX_SECTIONS.some(([known]) => known === prefix) ? `${prefix}:${scope}` : null
}

function formatScope(scope) {
  return scope ? scope : 'other'
}

export function groupAndroidReleaseNotes(body) {
  const groups = new Map()
  const rest = []
  const trailer = []
  let inList = false

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (inList && /^#{1,4}\s/.test(line)) {
      // A generated heading (e.g. "New Contributors") ends the What's Changed list.
      inList = false
      trailer.push(raw)
      continue
    }
    if (LINE_PREFIX.test(line) && (inList || trailer.length === 0)) {
      const key = groupKey(titleOf(line))
      if (key) {
        if (!groups.has(key)) {
          groups.set(key, [])
        }
        groups.get(key).push(raw)
      } else {
        if (!groups.has(OTHER_SECTION)) {
          groups.set(OTHER_SECTION, [])
        }
        groups.get(OTHER_SECTION).push(raw)
      }
      inList = true
      continue
    }
    // Generated headings and prose stay out of the sections: what precedes the
    // list goes back on top, what follows it ("New Contributors", "Full
    // Changelog") goes back on the bottom.
    ;(inList || trailer.length > 0 ? trailer : rest).push(raw)
  }

  if (groups.size === 0) {
    return body
  }

  const out = rest.join('\n').replace(/\s+$/, '')
  const ordered = []
  for (const [prefix, sectionTitle] of PREFIX_SECTIONS) {
    const scopes = [...groups.keys()].filter((key) => key.startsWith(`${prefix}:`)).sort()
    if (scopes.length === 0) {
      continue
    }
    ordered.push(`### ${sectionTitle}`)
    for (const key of scopes) {
      const scope = key.slice(prefix.length + 1)
      if (scopes.length > 1) {
        ordered.push(`#### ${formatScope(scope)}`)
      }
      ordered.push(groups.get(key).join('\n'), '')
    }
  }
  if (groups.has(OTHER_SECTION)) {
    ordered.push(`### ${OTHER_SECTION}`, groups.get(OTHER_SECTION).join('\n'), '')
  }
  const tail = trailer.join('\n').replace(/\s+$/, '')
  return `${out}\n\n${ordered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n${tail ? `\n${tail}\n` : ''}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, writeFileSync } = await import('node:fs')
  writeFileSync(1, groupAndroidReleaseNotes(readFileSync(0, 'utf8')))
}
