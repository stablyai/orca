import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSessionEnv } from './hook-bridge'

describe('resolveSessionEnv', () => {
  let tmp = ''
  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true })
      tmp = ''
    }
  })

  it('prefers the live endpoint file over stale static env (port + token)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'orca-ep-'))
    const ep = join(tmp, 'endpoint.env')
    writeFileSync(
      ep,
      'ORCA_AGENT_HOOK_PORT=44641\nORCA_AGENT_HOOK_TOKEN=live-token\nORCA_AGENT_HOOK_ENV=production\n'
    )
    const r = resolveSessionEnv({
      ORCA_PANE_KEY: 'tab:leaf',
      ORCA_AGENT_HOOK_PORT: '34977', // stale (pre-restart)
      ORCA_AGENT_HOOK_TOKEN: 'stale-token',
      ORCA_AGENT_HOOK_ENDPOINT: ep
    } as NodeJS.ProcessEnv)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.env.hookPort).toBe('44641')
      expect(r.env.hookToken).toBe('live-token')
      expect(r.env.paneKey).toBe('tab:leaf')
    }
  })

  it('falls back to the static env when no endpoint file is set', () => {
    const r = resolveSessionEnv({
      ORCA_PANE_KEY: 'p',
      ORCA_AGENT_HOOK_PORT: '5000',
      ORCA_AGENT_HOOK_TOKEN: 'tok'
    } as NodeJS.ProcessEnv)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.env.hookPort).toBe('5000')
      expect(r.env.hookToken).toBe('tok')
    }
  })

  it('falls back to the static env when the endpoint file is unreadable', () => {
    const r = resolveSessionEnv({
      ORCA_PANE_KEY: 'p',
      ORCA_AGENT_HOOK_PORT: '5000',
      ORCA_AGENT_HOOK_TOKEN: 'tok',
      ORCA_AGENT_HOOK_ENDPOINT: '/nonexistent/endpoint.env'
    } as NodeJS.ProcessEnv)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.env.hookPort).toBe('5000')
    }
  })

  it('errors loudly when not in an Orca session', () => {
    const r = resolveSessionEnv({} as NodeJS.ProcessEnv)
    expect(r.ok).toBe(false)
  })
})
