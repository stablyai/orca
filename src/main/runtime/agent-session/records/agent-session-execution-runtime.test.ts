import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSessionUsageBuildHash } from './agent-session-execution-runtime'

it('binds desktop usage to the executing main bundle and refuses missing or unbundled entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-runtime-'))
  try {
    const entry = join(root, 'index.js')
    writeFileSync(entry, '')
    expect(readSessionUsageBuildHash(entry)).toBe('e3b0c44298fc1c14')
    expect(readSessionUsageBuildHash(join(root, 'missing', 'index.js'))).toBe('unknown')
    expect(readSessionUsageBuildHash(join(root, 'source.ts'))).toBe('unknown')
  } finally {
    rmSync(root, { recursive: true })
  }
})
