import { describe, expect, it } from 'vitest'

import { selectRemoteInstallModel } from './remote-install-coexistence'

const BOTH_INSTALLED = ['relay-0.1.0+aa01', 'orcad-0.2.0+bb01', 'orcad-0.1.0+aa01']

describe('what a client does when it finds both models installed', () => {
  it('uses the registered model and leaves the other install alone', () => {
    const selection = selectRemoteInstallModel({
      registration: 'orcad-peer',
      installedDirNames: BOTH_INSTALLED
    })
    expect(selection).toMatchObject({ outcome: 'use', model: 'orcad' })
    expect(selection.outcome === 'use' && selection.coexisting).toEqual(['relay-0.1.0+aa01'])
    expect(selection.outcome === 'use' && selection.note).toContain(
      'garbage-collects only its own namespace'
    )
  })

  it('does not switch model just because the other one is also on disk', () => {
    const selection = selectRemoteInstallModel({
      registration: 'ssh-target',
      installedDirNames: BOTH_INSTALLED
    })
    expect(selection).toMatchObject({ outcome: 'use', model: 'relay' })
    expect(selection.outcome === 'use' && selection.coexisting).toEqual([
      'orcad-0.2.0+bb01',
      'orcad-0.1.0+aa01'
    ])
  })

  it('picks the registered model even when only the other one is installed', () => {
    // On-disk presence is diagnostic, never a vote: an orcad-registered host with only relay
    // dirs is a first orcad deploy, not a reason to fall back to the relay.
    const selection = selectRemoteInstallModel({
      registration: 'orcad-peer',
      installedDirNames: ['relay-0.1.0+aa01']
    })
    expect(selection).toMatchObject({ outcome: 'use', model: 'orcad' })
  })

  it('refuses a machine registered under both models', () => {
    const selection = selectRemoteInstallModel({
      registration: 'both',
      installedDirNames: BOTH_INSTALLED
    })
    expect(selection).toMatchObject({
      outcome: 'refuse',
      code: 'remote_host_registered_under_both_models'
    })
    // The forbidden thing is two registrations, not two directories — say so, or a user will
    // "fix" it by deleting an install that is serving someone.
    expect(selection.outcome === 'refuse' && selection.reason).toContain(
      'Leaving both install directories on disk is fine'
    )
  })

  it('refuses to infer a model for an unregistered machine', () => {
    const selection = selectRemoteInstallModel({
      registration: 'none',
      installedDirNames: BOTH_INSTALLED
    })
    expect(selection).toMatchObject({
      outcome: 'refuse',
      code: 'remote_host_not_registered'
    })
  })

  it('says nothing when there is nothing coexisting', () => {
    const selection = selectRemoteInstallModel({
      registration: 'orcad-peer',
      installedDirNames: ['orcad-0.2.0+bb01']
    })
    expect(selection).toMatchObject({ outcome: 'use', model: 'orcad', note: null })
  })
})
