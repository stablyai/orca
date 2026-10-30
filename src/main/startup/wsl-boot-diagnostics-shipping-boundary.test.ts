import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../..')
// Markers of the e2e harness that patches main's fs and child_process; shipped code never carries them.
const HARNESS_MARKERS = [
  'wsl-boot-diagnostics-log',
  'orcaE9SpawnLog',
  'recordMainProcessWslDiagnostics'
]

function shippedSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : shippedSources(full)
    }
    return /\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)
      ? [full]
      : []
  })
}

describe('E9 WSL boot diagnostics stay in the e2e harness', () => {
  it('no shipped source imports or installs the fs and spawn hooks', () => {
    const sources = shippedSources(SRC)
    // Non-vacuous: the scan really walked the app's sources.
    expect(sources.some((file) => file.endsWith(path.join('main', 'index.ts')))).toBe(true)
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return HARNESS_MARKERS.some((marker) => text.includes(marker))
    })
    expect(offenders).toEqual([])
  })
})
