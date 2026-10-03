import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { probeClaudeCliVersionCached } from './claude-hook-event-versions'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it.skipIf(process.platform === 'win32')(
  'probes a Claude binary once per identity and again after an upgrade',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-version-cache-'))
    roots.push(root)
    const binary = join(root, 'claude')
    const calls = join(root, 'calls')
    const install = (version: string) => {
      writeFileSync(binary, `#!/bin/sh\necho x >> '${calls}'\necho '${version} (Claude Code)'\n`)
      chmodSync(binary, 0o700)
    }
    install('2.1.261')
    expect(await probeClaudeCliVersionCached(binary)).toBe('2.1.261')
    expect(await probeClaudeCliVersionCached(binary)).toBe('2.1.261')
    expect(readFileSync(calls, 'utf8')).toBe('x\n')
    install('2.10.300')
    expect(await probeClaudeCliVersionCached(binary)).toBe('2.10.300')
    expect(readFileSync(calls, 'utf8')).toBe('x\nx\n')
  }
)
