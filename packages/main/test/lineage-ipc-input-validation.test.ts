import { describe, expect, it } from 'vitest'
import {
  addLineageManualLink,
  removeLineageManualLink
} from '../../../src/main/lineage/lineage-manual-links'
import { testLineagePattern } from '../../../src/main/lineage/lineage-pattern-test'
import { resolveLineageMembers } from '../../../src/main/lineage/lineage-member-resolver'
import { extractKeysWithPattern } from '../../../src/main/lineage/lineage-key-extraction'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'

const store: LineageStoreContract = {
  getRepos: () => [{ id: 'r1', path: '/r', displayName: 'loan-core' }],
  getLineageManualLinks: () => [],
  setLineageManualLinks: () => {}
}

describe('lineage ipc input validation', () => {
  it('rejects empty or non-string add-manual-link inputs without throwing', async () => {
    for (const args of [
      { parentWorkspaceKey: '', reference: 'loan-core#1' },
      { parentWorkspaceKey: 'p', reference: '' },
      { parentWorkspaceKey: 5, reference: 'loan-core#1' },
      { parentWorkspaceKey: 'p', reference: 'loan-core#1'.padEnd(2049, 'x') },
      { parentWorkspaceKey: 'p', target: { kind: 'nonsense' } },
      { parentWorkspaceKey: 'p', target: { kind: 'branch', repoId: 7, branch: 'x' } },
      { parentWorkspaceKey: 'p', target: { kind: 'worktree', repoId: 'r1' } },
      { parentWorkspaceKey: 'p', target: { kind: 'pr', reference: 12 } },
      { parentWorkspaceKey: 'p', target: 'loan-core#1' },
      undefined
    ]) {
      // @ts-expect-error deliberately malformed IPC payload
      const res = await addLineageManualLink(store, args)
      expect(res.success).toBe(false)
      expect(res.error).toBeTruthy()
    }
  })
  it('rejects empty remove-manual-link inputs', () => {
    expect(removeLineageManualLink(store, { parentWorkspaceKey: 'p', linkId: '' })).toEqual({
      success: false
    })
    // @ts-expect-error deliberately malformed IPC payload
    expect(removeLineageManualLink(store, null)).toEqual({ success: false })
  })
  it('test-pattern rejects empty and oversized inputs as keys: [] + error', () => {
    expect(testLineagePattern({ towerName: '', keyRegex: 'a' })).toMatchObject({
      keys: []
    })
    expect(testLineagePattern({ towerName: '', keyRegex: 'a' }).error).toBeTruthy()
    expect(testLineagePattern({ towerName: 'x', keyRegex: '' }).error).toBeTruthy()
    expect(testLineagePattern({ towerName: 'x'.repeat(501), keyRegex: 'x' }).error).toBeTruthy()
    expect(testLineagePattern({ towerName: 'x', keyRegex: 'x'.repeat(201) }).error).toBeTruthy()
    // @ts-expect-error deliberately malformed IPC payload
    expect(testLineagePattern(undefined).keys).toEqual([])
  })
  it('test-pattern passes valid input through', () => {
    expect(testLineagePattern({ towerName: 'g::ABC-12', keyRegex: '[A-Z]+-\\d+' })).toEqual({
      keys: ['ABC-12']
    })
  })
  it('a saved regex longer than 200 chars falls back to the default with an error', () => {
    const res = extractKeysWithPattern('g::LEVGP-48', 'x'.repeat(201))
    expect(res.keys).toEqual(['LEVGP-48'])
    expect(res.error).toBeTruthy()
  })
  it('get-members with an empty key returns an empty result', async () => {
    const res = await resolveLineageMembers(store, '')
    expect(res.members).toEqual([])
  })
})
