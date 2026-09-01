import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The host resolver and its host-only contract must never reach a renderer,
// mobile, or web bundle. Type location alone is not a security boundary; this
// grep is the enforcement (allowed importers: src/main/**, src/shared/**, tests).
const REPO_ROOT = join(__dirname, '..', '..', '..')

const CLIENT_ROOTS = ['src/renderer', 'mobile/src', 'src/web']

const FORBIDDEN_IMPORTS = [
  'agent-launch-host-contract',
  'agent-launch/resolve-agent-launch',
  'agent-launch/resolve-agent-command',
  'agent-launch/resolve-agent-selection',
  'agent-launch/compose-agent-launch-env'
]

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') {
        continue
      }
      collectSourceFiles(full, out)
      continue
    }
    const dot = entry.lastIndexOf('.')
    if (dot !== -1 && SOURCE_EXT.has(entry.slice(dot))) {
      out.push(full)
    }
  }
}

describe('agent-launch host-boundary imports', () => {
  it('no renderer/mobile/web source imports the host resolver or host contract', () => {
    const files: string[] = []
    for (const root of CLIENT_ROOTS) {
      collectSourceFiles(join(REPO_ROOT, root), files)
    }
    // Guard against silently scanning nothing (e.g. a moved directory).
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (text.includes(forbidden)) {
          offenders.push(`${file} -> ${forbidden}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
