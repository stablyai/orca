import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import {
  codexChatAppServerArgs,
  codexToolCheckBasis,
  watchCodexToolCheckArgs
} from './bot-tools-codex-args'

const withArgs = (codex: string): Partial<GlobalSettings> => ({ agentDefaultArgs: { codex } })

describe('codexChatAppServerArgs', () => {
  it('keeps a quoted -c override whole, as a chat’s app-server gets it', () => {
    expect(
      codexChatAppServerArgs(withArgs(`-c 'mcp_servers.notion.command="npx -y notion"'`))
    ).toEqual({ args: ['-c', 'mcp_servers.notion.command="npx -y notion"'] })
  })

  it('takes nothing from the Command wrapper: only Arguments are root options', () => {
    // The settings a chat launches from carry both; the wrapper goes before the CLI, not here.
    const settings: Partial<GlobalSettings> = {
      ...withArgs(`-c 'model="o3"'`),
      agentCmdOverrides: { codex: 'wrapper --flag codex' }
    }
    expect(codexChatAppServerArgs(settings)).toEqual({ args: ['-c', 'model="o3"'] })
  })

  it('says Arguments a chat can’t launch with are invalid, apart from none at all', () => {
    expect(codexChatAppServerArgs(withArgs(`-c 'unterminated`))).toEqual({
      invalid: expect.any(String)
    })
    expect(codexChatAppServerArgs(withArgs(''))).toEqual({ args: [] })
    expect(codexChatAppServerArgs({})).toEqual({ args: [] })
  })
})

describe('codexToolCheckBasis', () => {
  it('is opaque: it carries none of the Arguments', () => {
    const basis = codexToolCheckBasis({ args: ['-c', 'mcp_servers.secret.env.TOKEN="s3cr3t"'] })
    expect(basis).toMatch(/^[0-9a-f]{16}$/)
    expect(basis).not.toContain('s3cr3t')
  })

  it('tells invalid, empty and other Arguments apart, and the same ones alike', () => {
    const empty = codexToolCheckBasis({ args: [] })
    expect(codexToolCheckBasis(undefined)).toBe(empty)
    expect(codexToolCheckBasis({ invalid: 'bad' })).not.toBe(empty)
    expect(codexToolCheckBasis({ args: ['-c', 'a=1'] })).not.toBe(empty)
    expect(codexToolCheckBasis({ args: ['-c', 'a=1'] })).toBe(
      codexToolCheckBasis({ args: ['-c', 'a=1'] })
    )
  })
})

describe('watchCodexToolCheckArgs', () => {
  function store(initial: Partial<GlobalSettings>) {
    let listener: ((updates: unknown, settings: Partial<GlobalSettings>) => void) | null = null
    return {
      getSettings: () => initial,
      onSettingsChanged: (next: typeof listener) => {
        listener = next
        return () => {}
      },
      change: (settings: Partial<GlobalSettings>) => listener?.({}, settings)
    }
  }

  it('tells of each change a check loads: to invalid, from invalid, and back; not of others', () => {
    const settings = store(withArgs(''))
    const changed = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two store reads the watcher calls
    watchCodexToolCheckArgs(settings as never, changed)
    settings.change({ ...withArgs(''), agentCmdOverrides: { codex: 'other' } })
    expect(changed).not.toHaveBeenCalled()
    settings.change(withArgs(`-c 'unterminated`))
    expect(changed).toHaveBeenCalledTimes(1)
    settings.change(withArgs('-c model="o4"'))
    settings.change(withArgs(''))
    expect(changed).toHaveBeenCalledTimes(3)
  })
})
