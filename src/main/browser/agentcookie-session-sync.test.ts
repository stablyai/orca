import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./browser-cookie-import', () => ({
  importCookiesFromJson: vi.fn()
}))

import {
  AgentcookieSessionSync,
  detectAgentcookie,
  pullAgentcookieSession
} from './agentcookie-session-sync'

describe('detectAgentcookie', () => {
  let dir: string
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds an executable agentcookie on PATH', () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-detect-'))
    const exe = join(dir, 'agentcookie')
    writeFileSync(exe, '#!/bin/sh\n')
    chmodSync(exe, 0o755)
    expect(detectAgentcookie(dir)).toBe(exe)
  })

  it('returns null when not on PATH', () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-detect-'))
    expect(detectAgentcookie(dir)).toBeNull()
    expect(detectAgentcookie('')).toBeNull()
  })
})

describe('pullAgentcookieSession', () => {
  it('is a no-op (null) when agentcookie is not installed', async () => {
    expect(await pullAgentcookieSession('persist:orca-browser', null)).toBeNull()
  })
})

describe('AgentcookieSessionSync', () => {
  const origPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = origPath
  })

  it('does nothing and reports not-detected when agentcookie is absent', () => {
    process.env.PATH = ''
    const onStatus = vi.fn()
    const sync = new AgentcookieSessionSync({
      targetPartition: 'persist:orca-browser',
      isEnabled: () => true,
      onStatus
    })
    sync.start()
    expect(onStatus).toHaveBeenCalledWith({ detected: false, lastSyncAt: null, lastImported: null })
    sync.stop()
  })

  it('reports detected but does not sync when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sync-'))
    const exe = join(dir, 'agentcookie')
    writeFileSync(exe, '#!/bin/sh\necho "[]"\n')
    chmodSync(exe, 0o755)
    process.env.PATH = dir
    const onStatus = vi.fn()
    const sync = new AgentcookieSessionSync({
      targetPartition: 'persist:orca-browser',
      isEnabled: () => false,
      onStatus
    })
    sync.start()
    expect(onStatus).toHaveBeenCalledWith({ detected: true, lastSyncAt: null, lastImported: null })
    // Disabled: no second status from a sync cycle.
    expect(onStatus).toHaveBeenCalledTimes(1)
    sync.stop()
    rmSync(dir, { recursive: true, force: true })
  })
})
