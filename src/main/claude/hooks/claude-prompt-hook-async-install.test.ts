import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { ClaudeHookService } from '../hook-service'

describe.skipIf(process.platform === 'win32')(
  'Claude prompt hook async by resolved version',
  () => {
    let tmpHome: string
    let settingsPath: string

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-prompt-async-'))
      settingsPath = join(tmpHome, '.claude', 'settings.json')
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    })

    const promptHook = () =>
      JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks.UserPromptSubmit[0].hooks[0]

    it('runs the prompt hook async only on Claude builds that order a late prompt, and drops it on a downgrade', () => {
      const service = new ClaudeHookService()
      service.install({ claudeVersion: '2.1.280' })
      expect(promptHook().async).toBe(true)

      service.install({})
      expect(promptHook().async).toBeUndefined()

      service.install({ claudeVersion: '2.1.280' })
      service.install({ claudeVersion: '2.1.279' })
      expect(promptHook().async).toBeUndefined()
    })
  }
)
