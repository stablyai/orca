import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSystemCodexHookAuthority } from './system-hook-authority'

const testHomes: string[] = []

function createSystemHome(): string {
  const homePath = mkdtempSync(join(tmpdir(), 'orca-system-hook-authority-'))
  testHomes.push(homePath)
  mkdirSync(homePath, { recursive: true })
  return homePath
}

afterEach(() => {
  for (const homePath of testHomes.splice(0)) {
    rmSync(homePath, { recursive: true, force: true })
  }
})

describe('system Codex hook authority', () => {
  it('uses legacy hooks only when config.toml does not exist', () => {
    const homePath = createSystemHome()
    const legacyHooksPath = join(homePath, 'hooks.json')
    writeFileSync(
      legacyHooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'legacy-user-hook' }] }]
        }
      }),
      'utf-8'
    )

    expect(readSystemCodexHookAuthority(homePath)).toEqual({
      sourcePath: legacyHooksPath,
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'legacy-user-hook' }] }]
      }
    })
  })

  it('uses legacy hooks while config.toml has no executable declarations', () => {
    const homePath = createSystemHome()
    const systemTomlPath = join(homePath, 'config.toml')
    writeFileSync(systemTomlPath, 'model = "gpt-5"\n', 'utf-8')
    writeFileSync(
      join(homePath, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'stale-legacy-hook' }] }]
        }
      }),
      'utf-8'
    )

    expect(readSystemCodexHookAuthority(homePath)).toEqual({
      sourcePath: join(homePath, 'hooks.json'),
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'stale-legacy-hook' }] }]
      }
    })
  })

  it('uses legacy hooks when config.toml is malformed during migration', () => {
    const homePath = createSystemHome()
    const systemTomlPath = join(homePath, 'config.toml')
    const onInlineError = vi.fn()
    writeFileSync(systemTomlPath, 'model = "unterminated\n', 'utf-8')
    writeFileSync(
      join(homePath, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'stale-legacy-hook' }] }]
        }
      }),
      'utf-8'
    )

    expect(readSystemCodexHookAuthority(homePath, onInlineError)).toEqual({
      sourcePath: join(homePath, 'hooks.json'),
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'stale-legacy-hook' }] }]
      }
    })
    expect(onInlineError).toHaveBeenCalledOnce()
  })

  it('fails closed when an executable hook uses an unsupported TOML representation', () => {
    const homePath = createSystemHome()
    const systemTomlPath = join(homePath, 'config.toml')
    const onInlineError = vi.fn()
    writeFileSync(
      systemTomlPath,
      [
        '[hooks]',
        'Stop = [{ hooks = [{ type = "command", command = "unsupported-hook" }] }]',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(readSystemCodexHookAuthority(homePath, onInlineError)).toEqual({
      sourcePath: systemTomlPath,
      hooks: {}
    })
    expect(onInlineError).toHaveBeenCalledOnce()
  })
})
