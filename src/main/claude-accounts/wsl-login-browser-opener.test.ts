import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as fsTypes from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWslLoginConfigDirScript,
  buildWslLoginOpenerShellScript,
  buildWslLoginPathExport,
  createWslLoginOpenerHandoff,
  parseWslLoginConfigDirOutput,
  parseWslLoginOpenerHandoff
} from './wsl-login-browser-opener'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsTypes>()
  return { ...actual, rmSync: vi.fn(actual.rmSync) }
})

describe('WSL Claude login browser opener', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds a self-testing atomic opener and encoded-safe provisioning script', () => {
    const opener = buildWslLoginOpenerShellScript()
    const script = buildWslLoginConfigDirScript()
    expect(opener).toContain('ORCA_CLAUDE_OPENER_SELFTEST')
    expect(opener).toContain('mv -f')
    expect(opener).toContain('$1')
    expect(script).toContain("<<'ORCA_CLAUDE_OPENER'")
    expect(script).toContain(`${opener}\nORCA_CLAUDE_OPENER`)
    expect(script).toContain('mktemp -d "${TMPDIR:-/tmp}/orca-claude-login.XXXXXX"')
    expect(script).toContain('chmod 700')
    expect(script).toContain('trap cleanup EXIT')
  })

  it('parses the last valid WSL directory marker and appends the opener to PATH', () => {
    expect(
      parseWslLoginConfigDirOutput(
        'noise\u0000\nORCA_CLAUDE_LOGIN_DIR=/tmp/old\nORCA_CLAUDE_LOGIN_DIR=/tmp/new\n'
      )
    ).toBe('/tmp/new')
    expect(parseWslLoginConfigDirOutput('ORCA_CLAUDE_LOGIN_DIR=relative')).toBeNull()
    expect(buildWslLoginPathExport('/tmp/with space')).toBe(
      `export PATH="$PATH":'/tmp/with space/orca-opener'; `
    )
  })

  it.each([
    'http://localhost/callback',
    'file:///tmp/x',
    'javascript:alert(1)',
    'not a url',
    'https://example.com/a\nhttps://evil.example/',
    'https://platform.claude.com.evil.example/callback',
    'https://platform.claude.com:443/callback',
    'https://user:pass@platform.claude.com/callback',
    'https://platform.claude.com/callback#state=b',
    'https://localhost/callback',
    'https://evil.example/callback'
  ])('rejects unsafe handoff %s', (value) => {
    expect(parseWslLoginOpenerHandoff(value)).toBeNull()
  })

  it('preserves a valid HTTPS authorization URL', () => {
    expect(
      parseWslLoginOpenerHandoff(' https://platform.claude.com/oauth/code/callback?code=a%2Fb ')
    ).toBe('https://platform.claude.com/oauth/code/callback?code=a%2Fb')
    expect(parseWslLoginOpenerHandoff('https://claude.com/callback?x=1')).toBe(
      'https://claude.com/callback?x=1'
    )
    expect(parseWslLoginOpenerHandoff('https://console.anthropic.com/callback')).toBe(
      'https://console.anthropic.com/callback'
    )
    expect(parseWslLoginOpenerHandoff('https://anthropic.com/callback')).toBe(
      'https://anthropic.com/callback'
    )
  })

  it('bounds the handoff read before validation', () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'orca-wsl-opener-limit-'))
    mkdirSync(join(root, 'orca-opener'))
    const onUrl = vi.fn()
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
      `https://platform.claude.com/callback?value=${'a'.repeat(9000)}`
    )
    vi.advanceTimersByTime(200)
    expect(onUrl).not.toHaveBeenCalled()
    expect(onInvalid).toHaveBeenCalledTimes(1)
    expect(onReadError).not.toHaveBeenCalled()
    watcher.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('deletes the handoff before validation and accepts only the first write', () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'orca-wsl-opener-test-'))
    const openerDir = join(root, 'orca-opener')
    mkdirSync(openerDir)
    const onUrl = vi.fn()
    const onInvalid = vi.fn()
    const onReadError = vi.fn()
    const watcher = createWslLoginOpenerHandoff({
      windowsConfigDir: root,
      onUrl,
      onInvalid,
      onReadError
    })
    const handoff = join(root, 'open-url.request')
    writeFileSync(handoff, 'https://platform.claude.com/oauth/code/callback?code=one')
    vi.advanceTimersByTime(200)
    expect(onUrl).toHaveBeenCalledWith('https://platform.claude.com/oauth/code/callback?code=one')
    expect(onInvalid).not.toHaveBeenCalled()
    expect(() => readFileSync(handoff, 'utf8')).toThrow()
    writeFileSync(handoff, 'https://platform.claude.com/oauth/code/callback?code=two')
    vi.advanceTimersByTime(400)
    expect(onUrl).toHaveBeenCalledTimes(1)
    watcher.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('reports cleanup failures instead of dispatching a read URL', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'orca-wsl-opener-cleanup-'))
    mkdirSync(join(root, 'orca-opener'))
    const onUrl = vi.fn()
    const onInvalid = vi.fn()
    const onReadError = vi.fn()
    const actual = await vi.importActual<typeof fsTypes>('node:fs')
    const remove = vi.mocked(rmSync)
    remove.mockImplementation((path, options) => {
      if (String(path).endsWith('.consumed')) {
        throw new Error('cleanup failed')
      }
      return actual.rmSync(path, options)
    })
    const watcher = createWslLoginOpenerHandoff({
      windowsConfigDir: root,
      onUrl,
      onInvalid,
      onReadError
    })
    writeFileSync(
      join(root, 'open-url.request'),
      'https://platform.claude.com/callback?code=cleanup'
    )
    vi.advanceTimersByTime(200)
    expect(onUrl).not.toHaveBeenCalled()
    expect(onInvalid).not.toHaveBeenCalled()
    expect(onReadError).toHaveBeenCalledTimes(1)
    expect(() => readFileSync(join(root, 'open-url.request.consumed'), 'utf8')).not.toThrow()
    watcher.stop()
    remove.mockImplementation(actual.rmSync)
    actual.rmSync(root, { recursive: true, force: true })
  })
})
