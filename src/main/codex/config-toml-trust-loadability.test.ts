import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type * as SmolToml from 'smol-toml'
import type * as InstallerUtilsRemote from '../agent-hooks/installer-utils-remote'

const mocks = vi.hoisted(() => {
  const state: {
    // Why: removal and enabled-flag edits cannot break real TOML, so these cases
    // make the parser reject the edited bytes to prove the write is still checked.
    rejectParse: ((content: string) => boolean) | null
    remoteFiles: Map<string, string>
  } = { rejectParse: null, remoteFiles: new Map() }
  return state
})

vi.mock('smol-toml', async (importOriginal) => {
  const actual = await importOriginal<typeof SmolToml>()
  return {
    ...actual,
    parse: (content: string) => {
      if (mocks.rejectParse?.(content)) {
        throw new Error('simulated unloadable TOML')
      }
      return actual.parse(content)
    }
  }
})

vi.mock('../agent-hooks/installer-utils-remote', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallerUtilsRemote>()
  return {
    ...actual,
    readHooksJsonRemote: async (_sftp: SFTPWrapper, path: string) =>
      JSON.parse(mocks.remoteFiles.get(path) ?? '{}'),
    readTextFileRemote: async (_sftp: SFTPWrapper, path: string) =>
      mocks.remoteFiles.get(path) ?? null,
    writeHooksJsonRemote: async (_sftp: SFTPWrapper, path: string, config: unknown) => {
      mocks.remoteFiles.set(path, JSON.stringify(config))
    },
    writeManagedScriptRemote: async () => {},
    writeTextFileRemoteAtomic: async (_sftp: SFTPWrapper, path: string, content: string) => {
      mocks.remoteFiles.set(path, content)
    }
  }
})

import {
  computeTrustKey,
  escapeTomlString,
  isCodexConfigTomlRefusedError,
  moveHookTrustEntries,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { applyMirroredRuntimeUserHookTrustStates } from './codex-hook-user-mirroring'
import { installCodexHooksRemote } from './codex-hook-remote-install'

let dir: string
let tomlPath: string
let hooksPath: string

function stopEntry(groupIndex = 0): CodexTrustEntry {
  return {
    sourcePath: hooksPath,
    eventLabel: 'stop',
    groupIndex,
    handlerIndex: 0,
    command: 'orca-hook.sh'
  }
}

function tomlKey(entry: CodexTrustEntry): string {
  return escapeTomlString(computeTrustKey(entry))
}

function expectRefusal(write: () => void): void {
  let thrown: unknown
  try {
    write()
  } catch (error) {
    thrown = error
  }
  expect(isCodexConfigTomlRefusedError(thrown)).toBe(true)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-codex-toml-loadability-'))
  tomlPath = join(dir, 'config.toml')
  hooksPath = join(dir, 'hooks.json')
  mocks.rejectParse = null
  mocks.remoteFiles.clear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('hook approval writes never break a config.toml Codex can load', () => {
  it.each([
    ['an inline hooks.state table', '[hooks]\nstate = { "x:stop:0:0" = { trusted_hash = "u" } }\n'],
    ['an inline hooks table', 'hooks = { state = {} }\n'],
    [
      "a dotted approval for Orca's own key",
      (): string => `hooks.state."${tomlKey(stopEntry())}".trusted_hash = "sha256:user"\n`
    ]
  ])('upsert refuses and leaves the file byte-identical: %s', (_case, content) => {
    const original = `model = "m"\n${typeof content === 'string' ? content : content()}`
    writeFileSync(tomlPath, original)

    expectRefusal(() => upsertHookTrustEntries(tomlPath, [stopEntry()]))

    expect(readFileSync(tomlPath, 'utf-8')).toBe(original)
  })

  it('upsert may still repair a file Codex already cannot load', () => {
    writeFileSync(tomlPath, 'model = \n')

    upsertHookTrustEntries(tomlPath, [stopEntry()])

    expect(readFileSync(tomlPath, 'utf-8')).toContain('trusted_hash')
  })

  it('a move refuses to land on a key the user approved as dotted keys', () => {
    const original =
      `hooks.state."${tomlKey(stopEntry(0))}".trusted_hash = "sha256:user"\n\n` +
      `[hooks.state."${tomlKey(stopEntry(1))}"]\ntrusted_hash = "sha256:moved"\n`
    writeFileSync(tomlPath, original)

    expectRefusal(() =>
      moveHookTrustEntries(tomlPath, [
        { oldKey: computeTrustKey(stopEntry(1)), newKey: computeTrustKey(stopEntry(0)) }
      ])
    )

    expect(readFileSync(tomlPath, 'utf-8')).toBe(original)
  })

  it('a removal is checked before it is written', () => {
    upsertHookTrustEntries(tomlPath, [stopEntry(0), { ...stopEntry(1), command: 'user.sh' }])
    const original = readFileSync(tomlPath, 'utf-8')
    mocks.rejectParse = (content) => !content.includes(computeTrustKey(stopEntry(0)))

    expectRefusal(() => removeHookTrustEntries(tomlPath, [computeTrustKey(stopEntry(0))]))

    expect(readFileSync(tomlPath, 'utf-8')).toBe(original)
  })

  it("mirroring a user hook's enabled state is checked before it is written", () => {
    upsertHookTrustEntries(tomlPath, [{ ...stopEntry(), enabled: true }])
    const original = readFileSync(tomlPath, 'utf-8')
    mocks.rejectParse = (content) => content.includes('enabled = false')

    expectRefusal(() =>
      applyMirroredRuntimeUserHookTrustStates(tomlPath, [{ entry: stopEntry(), enabled: false }])
    )

    expect(readFileSync(tomlPath, 'utf-8')).toBe(original)
  })

  it('the SSH installer reports the refusal and leaves the remote config.toml untouched', async () => {
    const remoteToml = '/home/u/.codex/config.toml'
    const original = 'model = "m"\nhooks = { state = {} }\n'
    mocks.remoteFiles.set(remoteToml, original)
    mocks.remoteFiles.set('/home/u/.codex/hooks.json', '{"hooks":{}}')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked remote helpers never touch the SFTP handle.
    const status = await installCodexHooksRemote({} as SFTPWrapper, '/home/u')

    expect(status).toMatchObject({
      state: 'error',
      detail: expect.stringContaining('defines hook approvals in a form Orca cannot add to')
    })
    expect(mocks.remoteFiles.get(remoteToml)).toBe(original)
  })
})

describe('reading approvals Codex or the user wrote without a table header', () => {
  it('reads an approval written as dotted keys', () => {
    writeFileSync(tomlPath, `hooks.state."${tomlKey(stopEntry())}".trusted_hash = "sha256:user"\n`)

    expect(readHookTrustEntries(tomlPath).get(computeTrustKey(stopEntry()))).toEqual({
      trustedHash: 'sha256:user',
      enabled: undefined
    })
  })

  it('reads an approval written as an inline table', () => {
    writeFileSync(
      tomlPath,
      `[hooks]\nstate = { "${tomlKey(stopEntry())}" = { trusted_hash = "sha256:user", enabled = false } }\n`
    )

    expect(readHookTrustEntries(tomlPath).get(computeTrustKey(stopEntry()))).toEqual({
      trustedHash: 'sha256:user',
      enabled: false
    })
  })
})
