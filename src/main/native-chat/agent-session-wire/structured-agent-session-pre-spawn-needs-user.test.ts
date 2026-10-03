// Which pre-spawn refusals say only the person can clear them is decided where each is thrown. Exactly
// these three may: a start refused for anything else before spawn is tried again on its own.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = join(__dirname, '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return sources(path)
    }
    return entry.name.endsWith('.ts') && !entry.name.includes('.test') ? [path] : []
  })
}

describe('a pre-spawn refusal that needs the person', () => {
  it('is marked at exactly its throw sites, for exactly three reasons', () => {
    const marked: string[] = []
    let markers = 0
    // The adapter defines the marker; every other file only sets it.
    for (const file of sources(MAIN).filter(
      (path) => !path.endsWith('structured-agent-session-adapter.ts')
    )) {
      const text = readFileSync(file, 'utf8')
      markers += text.match(/needsUser: true/g)?.length ?? 0
      for (const [, reason] of text.matchAll(/reason: '(\w+)',\s*needsUser: true/g)) {
        marked.push(reason ?? '')
      }
    }

    expect(marked.length).toBe(markers)
    expect([...new Set(marked)].sort()).toEqual([
      'managedAccountEnvOverride',
      'managedAccountUnsupported',
      'providerMissing'
    ])
  })
})
