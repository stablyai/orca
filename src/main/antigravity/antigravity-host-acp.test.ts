import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasAgyCredential } from './antigravity-host-acp'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

describe('hasAgyCredential', () => {
  it('leaves a keyring-fallback marker to the ACP readiness probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'))
    homes.push(home)
    const marker = join(home, '.gemini/antigravity-cli/cache/antigravity-keyring-unavailable')
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, '1794977777')
    await expect(hasAgyCredential(home)).resolves.toBe(true)
  })
})
