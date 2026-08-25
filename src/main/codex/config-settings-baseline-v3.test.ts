import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CodexFsUtils from '../codex-accounts/fs-utils'

const { atomicState } = vi.hoisted(() => ({
  atomicState: { fail: false, guardedCalls: 0 }
}))

vi.mock('../codex-accounts/fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexFsUtils>()
  return {
    ...actual,
    writeFileAtomically: (...args: Parameters<typeof actual.writeFileAtomically>) => {
      if (atomicState.fail) {
        throw new Error('injected baseline rename failure')
      }
      return actual.writeFileAtomically(...args)
    },
    writeFileAtomicallyIfUnchanged: (
      ...args: Parameters<typeof actual.writeFileAtomicallyIfUnchanged>
    ) => {
      atomicState.guardedCalls += 1
      return actual.writeFileAtomicallyIfUnchanged(...args)
    }
  }
})

import { MAX_AGENT_STATE_FILE_BYTES } from '../agent-state-file-reader'
import {
  getCodexSettingsBaselinePath,
  readCodexSettingsBaseline,
  writeCodexSettingsBaseline,
  type CodexSettingsBaseline
} from './config-settings-baseline'

let runtimeHomePath: string

beforeEach(() => {
  runtimeHomePath = mkdtempSync(join(tmpdir(), 'orca-codex-baseline-v3-'))
  atomicState.fail = false
  atomicState.guardedCalls = 0
})

afterEach(() => {
  rmSync(runtimeHomePath, { recursive: true, force: true })
  vi.clearAllMocks()
})

function baselinePath(): string {
  return getCodexSettingsBaselinePath(runtimeHomePath)
}

function makeBaseline(
  settings: ReadonlyMap<string, string | null>,
  conflicts: CodexSettingsBaseline['conflicts'] = new Map()
): CodexSettingsBaseline {
  return {
    settings,
    conflicts,
    knownPromotedKeys: new Set(['model', 'tui.theme']),
    sourceIsAuthoritative: true,
    tracksAllOrdinarySettings: true
  }
}

function readStoredBaseline(): {
  version: number
  settings: Record<string, string | null>
  sourceAuthority?: string
} {
  return JSON.parse(readFileSync(baselinePath(), 'utf-8'))
}

describe('Codex settings baseline v3 persistence', () => {
  it.each([
    {
      name: 'setting',
      value: {
        version: 3,
        sourceAuthority: 'mirrored',
        knownPromotedKeys: ['model'],
        settings: { model: 42 }
      }
    },
    {
      name: 'conflict',
      value: {
        version: 3,
        sourceAuthority: 'mirrored',
        knownPromotedKeys: ['model'],
        settings: {},
        conflicts: { model: { runtime: '"r"', system: false } }
      }
    },
    {
      name: 'known promoted key',
      value: {
        version: 3,
        sourceAuthority: 'mirrored',
        knownPromotedKeys: ['model', 42],
        settings: {}
      }
    },
    {
      name: 'structured key',
      value: {
        version: 3,
        sourceAuthority: 'mirrored',
        knownPromotedKeys: ['model'],
        settings: { '': '"invalid"' }
      }
    },
    {
      name: 'conflict container',
      value: {
        version: 3,
        sourceAuthority: 'mirrored',
        knownPromotedKeys: ['model'],
        settings: {},
        conflicts: []
      }
    }
  ])('rejects the whole baseline when a v3 $name is malformed', ({ value }) => {
    writeFileSync(baselinePath(), JSON.stringify(value), 'utf-8')

    expect(readCodexSettingsBaseline(runtimeHomePath)).toBeNull()
  })

  it('falls back to readable v2 when an escaped promoted value exceeds the byte limit', () => {
    const raw = `"${'\\'.repeat(MAX_AGENT_STATE_FILE_BYTES / 2 + 64)}"`

    writeCodexSettingsBaseline(runtimeHomePath, makeBaseline(new Map([['model', raw]])))

    expect(statSync(baselinePath()).size).toBeLessThanOrEqual(MAX_AGENT_STATE_FILE_BYTES)
    expect(readStoredBaseline()).toMatchObject({
      version: 2,
      settings: {},
      sourceAuthority: 'mirrored'
    })
    expect(readCodexSettingsBaseline(runtimeHomePath)).not.toBeNull()
  })

  it('writes v2 when ordinary tracking is requested without source authority', () => {
    writeCodexSettingsBaseline(runtimeHomePath, {
      settings: new Map([
        ['model', '"gpt-5"'],
        ['personality', '"local"']
      ]),
      conflicts: new Map(),
      knownPromotedKeys: new Set(['model']),
      sourceIsAuthoritative: false,
      tracksAllOrdinarySettings: true
    })

    expect(readStoredBaseline()).toMatchObject({
      version: 2,
      settings: { model: '"gpt-5"', personality: '"local"' }
    })
    expect(readStoredBaseline().sourceAuthority).toBeUndefined()
    expect(readCodexSettingsBaseline(runtimeHomePath)).toMatchObject({
      tracksAllOrdinarySettings: false,
      sourceIsAuthoritative: false
    })
  })

  it('keeps promoted ancestors when an unlisted value forces v2 fallback', () => {
    const settings = new Map<string, string | null>([
      ['model', '"gpt-5"'],
      ['personality', `"${'x'.repeat(MAX_AGENT_STATE_FILE_BYTES)}"`]
    ])

    writeCodexSettingsBaseline(runtimeHomePath, makeBaseline(settings))

    expect(readStoredBaseline()).toMatchObject({
      version: 2,
      settings: { model: '"gpt-5"' },
      sourceAuthority: 'mirrored'
    })
  })

  it('bounds baselines with many distinct ordinary keys', () => {
    const settings = new Map<string, string | null>()
    for (let index = 0; index < 48_000; index += 1) {
      settings.set(`ordinary_${index}`, `"${'x'.repeat(64)}"`)
    }
    settings.set('model', '"gpt-5"')

    writeCodexSettingsBaseline(runtimeHomePath, makeBaseline(settings))

    expect(readStoredBaseline()).toMatchObject({ version: 2, settings: { model: '"gpt-5"' } })
    expect(statSync(baselinePath()).size).toBeLessThanOrEqual(MAX_AGENT_STATE_FILE_BYTES)
  })

  it('uses UTF-8 byte length rather than JavaScript string length', () => {
    const multibyte = '界'.repeat(Math.floor(MAX_AGENT_STATE_FILE_BYTES / 2))
    expect(multibyte.length).toBeLessThan(MAX_AGENT_STATE_FILE_BYTES)

    writeCodexSettingsBaseline(
      runtimeHomePath,
      makeBaseline(
        new Map([
          ['model', '"gpt-5"'],
          ['personality', `"${multibyte}"`]
        ])
      )
    )

    expect(readStoredBaseline()).toMatchObject({ version: 2, settings: { model: '"gpt-5"' } })
  })

  it.skipIf(process.platform === 'win32')(
    'atomically writes baselines with owner-only mode',
    () => {
      writeCodexSettingsBaseline(runtimeHomePath, makeBaseline(new Map([['model', '"gpt-5"']])))

      expect(statSync(baselinePath()).mode & 0o777).toBe(0o600)
      expect(atomicState.guardedCalls).toBe(0)
    }
  )

  it('keeps the prior readable baseline when replacement fails', () => {
    writeCodexSettingsBaseline(runtimeHomePath, makeBaseline(new Map([['model', '"gpt-5"']])))
    const before = readFileSync(baselinePath(), 'utf-8')
    atomicState.fail = true

    expect(() =>
      writeCodexSettingsBaseline(runtimeHomePath, makeBaseline(new Map([['model', '"o4"']])))
    ).toThrow('injected baseline rename failure')
    expect(readFileSync(baselinePath(), 'utf-8')).toBe(before)
  })
})
