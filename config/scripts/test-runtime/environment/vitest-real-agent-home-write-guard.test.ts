import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { takeRealAgentHomeWriteViolations } from './vitest-real-agent-home-write-guard'

// Use missing-parent/no-op paths so guard ablation never writes real home either.
const missingRealFolder = (entry: string) =>
  join(userInfo().homedir, entry, `orca-vitest-guard-${randomUUID()}`)

afterEach(() => {
  takeRealAgentHomeWriteViolations()
  vi.unstubAllEnvs()
})

describe('vitest real-agent-home write guard', () => {
  it.each(['string', 'buffer', 'url'])(
    'refuses a named-import sync write through a %s path under the real ~/.codex',
    (pathType) => {
      const target = join(missingRealFolder('.codex'), 'config.toml')
      const input =
        pathType === 'buffer'
          ? Buffer.from(target)
          : pathType === 'url'
            ? pathToFileURL(target)
            : target
      expect(() => writeFileSync(input, '[projects."/tmp/x"]\n')).toThrow(/real-agent-home guard/)
      expect(existsSync(target)).toBe(false)
    }
  )

  it('allows only Claude transcript writes for the real CLI opt-in', () => {
    vi.stubEnv('ORCA_REAL_CLAUDE_CLI_TEST', '1')
    const missingTranscript = missingRealFolder(join('.claude', 'projects'))
    expect(() => rmSync(missingTranscript, { force: true })).not.toThrow()
    expect(() => rmSync(missingRealFolder('.codex'), { force: true })).toThrow(
      /real-agent-home guard/
    )
    expect(() => rmSync(missingRealFolder('.orca'), { force: true })).toThrow(
      /real-agent-home guard/
    )
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
