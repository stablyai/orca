import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearInheritedAgentStateEnv,
  takeRealAgentHomeWriteViolations
} from './vitest-real-agent-home-write-guard'

// Why never-created paths: each sits under a missing folder or is a forced no-op removal, so even
// with the guard off (the ablation) nothing lands in the real home.
const missingRealFolder = (entry: string) =>
  join(userInfo().homedir, entry, `orca-vitest-guard-${randomUUID()}`)

afterEach(() => {
  takeRealAgentHomeWriteViolations()
  vi.unstubAllEnvs()
})

describe('vitest real-agent-home write guard', () => {
  it.each([undefined, '', '0', 'true', '1'])(
    'keeps only the explicitly opted-in Claude profile for %s',
    (value) => {
      vi.stubEnv('ORCA_REAL_CLAUDE_CLI_TEST', value)
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/explicit-claude-profile')
      vi.stubEnv('CODEX_HOME', '/tmp/inherited-codex-profile')
      vi.stubEnv('ORCA_USER_DATA_PATH', '/tmp/inherited-orca-state')
      vi.stubEnv('ORCA_CODEX_LAUNCH_PREFLIGHT', '/tmp/inherited-live-cli')

      clearInheritedAgentStateEnv()

      expect(process.env.CLAUDE_CONFIG_DIR).toBe(
        value === '1' ? '/tmp/explicit-claude-profile' : undefined
      )
      expect(process.env.CODEX_HOME).toBeUndefined()
      expect(process.env.ORCA_USER_DATA_PATH).toBeUndefined()
      expect(process.env.ORCA_CODEX_LAUNCH_PREFLIGHT).toBeUndefined()
      expect(() => rmSync(missingRealFolder('.claude'), { force: true })).toThrow(
        /real-agent-home guard/
      )
    }
  )

  it('refuses a named-import sync write under the real ~/.codex', () => {
    const target = join(missingRealFolder('.codex'), 'config.toml')
    expect(() => writeFileSync(target, '[projects."/tmp/x"]\n')).toThrow(/real-agent-home guard/)
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a promise write under a ~/.claude.json sibling', async () => {
    const target = join(missingRealFolder('.claude.json'), 'x.tmp')
    await expect(writeFile(target, '{}')).rejects.toThrow(/real-agent-home guard/)
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a removal that would otherwise succeed silently', () => {
    expect(() => rmSync(missingRealFolder('.orca'), { recursive: true, force: true })).toThrow(
      /real-agent-home guard/
    )
  })

  it('still records a refusal the writer swallowed, so the test fails afterwards', () => {
    try {
      mkdirSync(join(missingRealFolder('.cursor'), 'projects'))
    } catch {
      // Trust writers swallow their errors like this.
    }
    expect(takeRealAgentHomeWriteViolations()).toEqual([expect.stringContaining('fs.mkdirSync')])
  })

  it('protects the account home even when HOME points elsewhere', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'orca-vitest-guard-home-'))
    vi.stubEnv('HOME', tempHome)
    vi.stubEnv('USERPROFILE', tempHome)
    try {
      expect(homedir()).not.toBe(userInfo().homedir)
      expect(() => rmSync(missingRealFolder('.copilot'), { force: true })).toThrow(
        /real-agent-home guard/
      )
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('leaves a sibling that only shares an agent folder prefix alone', () => {
    const sibling = join(userInfo().homedir, `.codex-orca-vitest-guard-${randomUUID()}`)
    expect(() => rmSync(sibling, { force: true })).not.toThrow()
  })

  it('stands down while an opted-in real-agent suite switch is set', () => {
    vi.stubEnv('ORCA_CODEX_TRUST_CONTRACT_BINARY', '/opt/codex')
    expect(() => rmSync(missingRealFolder('.codex'), { force: true })).not.toThrow()
  })

  it('allows reads there and writes under a temp home', () => {
    expect(() => openSync(join(missingRealFolder('.codex'), 'config.toml'), 'r')).toThrow(/ENOENT/)
    const tempHome = mkdtempSync(join(tmpdir(), 'orca-vitest-guard-home-'))
    try {
      const target = join(tempHome, '.codex', 'config.toml')
      mkdirSync(join(tempHome, '.codex'))
      writeFileSync(target, 'x')
      expect(existsSync(target)).toBe(true)
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
    expect(takeRealAgentHomeWriteViolations()).toEqual([])
  })
})
