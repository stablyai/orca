import { describe, expect, it } from 'vitest'
import { decideManagedHostRemoval } from './ssh-target-runtime-ownership'

const GONE = 'env-gone'
const LIVE = 'env-live'

describe('decideManagedHostRemoval', () => {
  it('removes an ordinary SSH host without reading the catalog', () => {
    expect(decideManagedHostRemoval({}, null)).toEqual({ kind: 'proceed' })
    expect(decideManagedHostRemoval(undefined, null)).toEqual({ kind: 'proceed' })
  })

  it('refuses while the referenced environment is still saved', () => {
    expect(
      decideManagedHostRemoval({ orcadFence: { environmentId: LIVE } }, new Set([LIVE, 'other']))
    ).toEqual({ kind: 'refuse' })
    expect(
      decideManagedHostRemoval(
        {
          orcadFence: { environmentId: GONE },
          orcadProvisioning: { requestId: LIVE, name: 'box' }
        },
        new Set([LIVE])
      )
    ).toEqual({ kind: 'refuse' })
  })

  it('clears a fence and a provisioning intent whose environment ids are absent', () => {
    expect(
      decideManagedHostRemoval(
        {
          orcadFence: { environmentId: GONE },
          orcadProvisioning: { requestId: GONE, name: 'box' }
        },
        new Set([LIVE])
      )
    ).toEqual({ kind: 'clear-dangling-reference' })
    expect(
      decideManagedHostRemoval({ orcadProvisioning: { requestId: GONE, name: 'box' } }, new Set())
    ).toEqual({ kind: 'clear-dangling-reference' })
  })

  it('keeps the refusal when the catalog cannot be read or the reference has no id', () => {
    expect(decideManagedHostRemoval({ orcadFence: { environmentId: GONE } }, null)).toEqual({
      kind: 'refuse'
    })
    expect(decideManagedHostRemoval({ orcadFence: { environmentId: '' } }, new Set())).toEqual({
      kind: 'refuse'
    })
  })
})
