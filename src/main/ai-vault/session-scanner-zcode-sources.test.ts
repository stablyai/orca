import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedAccess } from '../native-chat/wsl-transcript-fs-access'
import { zcodeDiscoveries } from './session-scanner-zcode-sources'

vi.mock('../native-chat/wsl-transcript-fs-access', () => ({ wslGatedAccess: vi.fn() }))

const access = vi.mocked(wslGatedAccess)

afterEach(() => access.mockReset())

it.each(['EACCES', 'EPERM', 'EIO'])(
  'reports a ZCode database %s error instead of treating it as absent',
  async (code) => {
    access.mockRejectedValueOnce(
      Object.assign(new Error(`Cannot read database: ${code}`), { code })
    )
    const issues: AiVaultScanIssue[] = []

    const [discovery] = await Promise.all(
      zcodeDiscoveries({ zcodeDbPath: '/example/db.sqlite' }, [], 10, issues)
    )

    expect(discovery?.files).toEqual([])
    expect(issues).toEqual([
      { agent: 'zcode', path: '/example/db.sqlite', message: `Cannot read database: ${code}` }
    ])
  }
)

it('silently skips a ZCode database that does not exist', async () => {
  access.mockRejectedValueOnce(Object.assign(new Error('No such file'), { code: 'ENOENT' }))
  const issues: AiVaultScanIssue[] = []

  const [discovery] = await Promise.all(
    zcodeDiscoveries({ zcodeDbPath: '/example/db.sqlite' }, [], 10, issues)
  )

  expect(discovery?.files).toEqual([])
  expect(issues).toEqual([])
})
