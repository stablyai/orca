import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createWslLoginOpenerHandoff,
  openWslLoginAuthorizationUrl
} from './wsl-login-browser-opener'

const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => undefined))

vi.mock('electron', () => ({ shell: { openExternal } }))

describe('WSL Claude login opener flow', () => {
  it('delivers one URL to the Windows-side browser owner and consumes the request', () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'orca-wsl-login-flow-'))
    mkdirSync(join(root, 'orca-opener'))
    const onUrl = vi.fn((url: string) => openWslLoginAuthorizationUrl(url))
    const onInvalid = vi.fn()
    const onReadError = vi.fn()
    const watcher = createWslLoginOpenerHandoff({
      windowsConfigDir: root,
      onUrl,
      onInvalid,
      onReadError
    })
    writeFileSync(
      join(root, 'open-url.request'),
      'https://platform.claude.com/oauth/code/callback?code=secret'
    )
    vi.advanceTimersByTime(200)
    expect(openExternal).toHaveBeenCalledWith(
      'https://platform.claude.com/oauth/code/callback?code=secret'
    )
    expect(onInvalid).not.toHaveBeenCalled()
    writeFileSync(
      join(root, 'open-url.request'),
      'https://platform.claude.com/oauth/code/callback?code=second'
    )
    vi.advanceTimersByTime(400)
    expect(openExternal).toHaveBeenCalledTimes(1)
    watcher.stop()
    rmSync(root, { recursive: true, force: true })
    vi.useRealTimers()
  })
})
