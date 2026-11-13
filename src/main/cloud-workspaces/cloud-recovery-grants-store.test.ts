import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCloudRecoveryGrantsStore } from './cloud-recovery-grants-store'

const dirs: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'recovery-grants-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

describe('cloud recovery grants store (GRANT-ID-TRACKING)', () => {
  it('remembers a grant per sandbox across instances (a restart), and forgets it', async () => {
    const d = dir()
    await createCloudRecoveryGrantsStore(d).set('sbx_1', 'grt_a')
    const again = createCloudRecoveryGrantsStore(d)
    expect(await again.get('sbx_1')).toBe('grt_a')
    await again.set('sbx_1', null)
    expect(await createCloudRecoveryGrantsStore(d).get('sbx_1')).toBeNull()
  })

  it('reads a missing or damaged file as empty, and drops malformed entries', async () => {
    const d = dir()
    expect(await createCloudRecoveryGrantsStore(d).get('sbx_1')).toBeNull()
    writeFileSync(join(d, 'cloud-recovery-grants.json'), '{not json')
    expect(await createCloudRecoveryGrantsStore(d).get('sbx_1')).toBeNull()
    writeFileSync(
      join(d, 'cloud-recovery-grants.json'),
      JSON.stringify({ sbx_1: 'grt_ok', sbx_2: 42, 'bad id!': 'grt_x' })
    )
    const store = createCloudRecoveryGrantsStore(d)
    expect(await store.get('sbx_1')).toBe('grt_ok')
    expect(await store.get('sbx_2')).toBeNull()
  })
})
