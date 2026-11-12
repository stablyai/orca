import { describe, expect, it } from 'vitest'
import { resolveRpcWorkspaceCreatorProvenance } from './workspace-creator-context'

describe('resolveRpcWorkspaceCreatorProvenance', () => {
  it("records a phone paired here as this host's owner", () => {
    expect(
      resolveRpcWorkspaceCreatorProvenance({ pairedDeviceId: 'phone', clientKind: 'mobile' })
    ).toEqual({ kind: 'host' })
  })

  it('records a delegated phone as the desktop that relays it', () => {
    expect(
      resolveRpcWorkspaceCreatorProvenance({
        pairedDeviceId: 'child',
        pairedDeviceParentId: 'desktop',
        clientKind: 'mobile'
      })
    ).toEqual({ kind: 'paired-device', deviceId: 'desktop' })
  })

  it('records a paired desktop as itself, and an in-process caller as the host', () => {
    expect(
      resolveRpcWorkspaceCreatorProvenance({ pairedDeviceId: 'laptop', clientKind: 'runtime' })
    ).toEqual({ kind: 'paired-device', deviceId: 'laptop' })
    expect(resolveRpcWorkspaceCreatorProvenance({})).toEqual({ kind: 'host' })
  })
})
