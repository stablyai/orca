import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'darwin')('macOS continuous quit chord predicate', () => {
  it('uses native clock boundaries and rejects key/modifier release, including between samples', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const temp = mkdtempSync(path.join(tmpdir(), 'orca-quit-chord-tests-'))
    try {
      const binary = path.join(temp, 'quit-chord-tests')
      execFileSync('swiftc', [
        path.join(root, 'native/keyboard-layout-macos/QuitChordWatch.swift'),
        path.join(root, 'native/keyboard-layout-macos/tests/main.swift'),
        '-module-cache-path',
        path.join(temp, 'cache'),
        '-o',
        binary
      ])
      expect(execFileSync(binary, { encoding: 'utf8' })).toContain('16 assertions passed')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 60000)
})
