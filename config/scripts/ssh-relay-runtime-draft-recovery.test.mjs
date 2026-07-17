import { describe, expect, it } from 'vitest'

import { planSshRelayRuntimeDraftRecovery } from './ssh-relay-runtime-draft-recovery.mjs'

const TAG = 'v1.5.0-rc.1'
const COMMIT = 'a'.repeat(40)

function asset(name, digit) {
  return { name, sha256: `sha256:${digit.repeat(64)}`, size: 1024 }
}

function fixture() {
  const expectedAssets = [
    asset('orca-ssh-relay-runtime-v1-linux-x64-glibc-a.tar.br', '1'),
    asset('orca-ssh-relay-runtime-v1-win32-x64-b.zip', '2'),
    asset('orca-ssh-relay-runtime-manifest.json', '3'),
    asset('orca-ssh-relay-runtime-manifest.sig', '4')
  ]
  return {
    tag: TAG,
    sourceCommit: COMMIT,
    expectedAssets,
    draft: { state: 'draft', tag: TAG, sourceCommit: COMMIT, assets: [] }
  }
}

describe('SSH relay runtime draft recovery', () => {
  it('plans all immutable assets for a new empty draft', () => {
    const input = fixture()
    expect(planSshRelayRuntimeDraftRecovery(input)).toEqual({
      reusableAssets: [],
      uploadAssets: input.expectedAssets
    })
  })

  it('reuses only exact immutable bytes from the same draft and source commit', () => {
    const input = fixture()
    input.draft.assets = [
      structuredClone(input.expectedAssets[0]),
      asset('orca-windows-setup.exe', '9')
    ]

    expect(planSshRelayRuntimeDraftRecovery(input)).toEqual({
      reusableAssets: [input.expectedAssets[0]],
      uploadAssets: input.expectedAssets.slice(1)
    })
  })

  it('rejects changed, empty, duplicate, or unexpected managed assets', () => {
    const changed = fixture()
    changed.draft.assets = [{ ...changed.expectedAssets[0], sha256: `sha256:${'f'.repeat(64)}` }]
    expect(() => planSshRelayRuntimeDraftRecovery(changed)).toThrow(/immutable bytes disagree/i)

    const empty = fixture()
    empty.draft.assets = [{ ...empty.expectedAssets[0], size: 0 }]
    expect(() => planSshRelayRuntimeDraftRecovery(empty)).toThrow(/invalid size/i)

    const duplicate = fixture()
    duplicate.draft.assets = [inputAsset(duplicate), inputAsset(duplicate)]
    expect(() => planSshRelayRuntimeDraftRecovery(duplicate)).toThrow(/duplicate/i)

    const unexpected = fixture()
    unexpected.draft.assets = [asset('orca-ssh-relay-runtime-v1-unknown.zip', '8')]
    expect(() => planSshRelayRuntimeDraftRecovery(unexpected)).toThrow(/unexpected managed asset/i)
  })

  it.each([
    [{ state: 'published' }, 'must remain draft'],
    [{ tag: 'v1.5.0-rc.2' }, 'tag'],
    [{ sourceCommit: 'b'.repeat(40) }, 'source commit']
  ])('rejects unsafe recovered draft state %o', (override, message) => {
    const input = fixture()
    Object.assign(input.draft, override)
    expect(() => planSshRelayRuntimeDraftRecovery(input)).toThrow(message)
  })
})

function inputAsset(input) {
  return structuredClone(input.expectedAssets[0])
}
