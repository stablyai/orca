import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createLiveOrcadProcess } from './orcad-live-process-fixture'
import type { ProfileLifetimeLockBinding } from '../ssh/profile-lifetime-lock'

const entry = process.env.ORCA_TEST_ORCAD_ENTRY
const addon = process.env.ORCA_TEST_PROFILE_LOCK_ADDON
afterEach(() => vi.unstubAllEnvs())

it.skipIf(!entry || !addon)(
  'holds native root exclusion from real Bun startup until owned process exit',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-admission-live-'))
    const runtime = createLiveOrcadProcess(entry!, directory, { mutationEnabled: false })
    const binding: ProfileLifetimeLockBinding = createRequire(import.meta.url)(addon!)
    vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', '1')
    vi.stubEnv('ORCA_PROFILE_LIFETIME_LOCK_ADDON', addon!)
    const path = join(directory, 'data', 'profile-lifetime.lock')
    try {
      await runtime.start()
      expect(() => binding.acquire(path)).toThrow(
        expect.objectContaining({ code: 'profile_lock_busy' })
      )
      await runtime.stop()
      const token = binding.acquire(path)
      try {
        binding.assertCurrent(token)
      } finally {
        binding.release(token)
      }
    } finally {
      await runtime.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  },
  180_000
)
