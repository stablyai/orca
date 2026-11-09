import { describe, expect, it } from 'vitest'
import {
  ownerOfHostId,
  ownerOfMirrorHostId,
  ownerOfWorkerHost,
  type OwnerContext,
  type WorkspaceServer
} from './row-owner-server'
import { annotateWorkspaces } from './workspace-address'

const LOCAL: WorkspaceServer = { id: 'local', name: 'local' }
const BUILD_BOX: WorkspaceServer = { id: 'env-1', name: 'build-box' }

/** The caller's store holds env-1. */
function context(answering: WorkspaceServer): OwnerContext {
  return { answering, savedServer: (id) => (id === 'env-1' ? BUILD_BOX : undefined) }
}

describe('the server that owns a row', () => {
  it('names the answering server for a local row', () => {
    expect(ownerOfHostId('local', context(LOCAL))).toEqual({ server: LOCAL })
    expect(ownerOfHostId('local', context(BUILD_BOX))).toEqual({ server: BUILD_BOX })
  })

  it("never names a stored row's runtime stamp, which another client may have written", () => {
    expect(ownerOfHostId('runtime:env-1', context(LOCAL))).toEqual({
      server: null,
      unknown: 'unverified-owner',
      stored: 'runtime:env-1'
    })
  })

  it("names a terminal mirror's runtime owner only from the local answer's own store", () => {
    expect(ownerOfMirrorHostId('runtime:env-1', context(LOCAL))).toEqual({ server: BUILD_BOX })
    expect(ownerOfMirrorHostId('runtime:env-9', context(LOCAL))).toEqual({
      server: null,
      unknown: 'unverified-owner',
      stored: 'runtime:env-9'
    })
  })

  it("never joins a remote server's runtime stamp against this computer's store", () => {
    expect(ownerOfMirrorHostId('runtime:env-1', context(BUILD_BOX))).toEqual({
      server: null,
      unknown: 'unverified-owner',
      stored: 'runtime:env-1'
    })
  })

  it('keeps conflicting, legacy SSH and missing owners unknown instead of local', () => {
    expect(ownerOfHostId('runtime:unresolved-owner', context(LOCAL))).toMatchObject({
      server: null,
      unknown: 'conflicting-ownership'
    })
    expect(ownerOfHostId('ssh:box', context(LOCAL))).toMatchObject({
      server: null,
      unknown: 'legacy-ssh-row'
    })
    expect(ownerOfHostId(undefined, context(LOCAL))).toMatchObject({
      server: null,
      unknown: 'owner-not-reported'
    })
  })

  it('names federated workers by their saved id and the home coordinator as answering', () => {
    expect(ownerOfWorkerHost({ kind: 'local', id: 'local' }, context(BUILD_BOX))).toEqual({
      server: BUILD_BOX
    })
    expect(ownerOfWorkerHost({ kind: 'remote', id: 'env-1' }, context(LOCAL))).toEqual({
      server: BUILD_BOX
    })
    expect(ownerOfWorkerHost({ kind: 'remote', id: 'ssh-1' }, context(LOCAL))).toMatchObject({
      server: null,
      unknown: 'unverified-owner'
    })
  })
})

describe('workspace annotation JSON', () => {
  it('names the owner and route under server keys', () => {
    const [stamped, stranger] = annotateWorkspaces(
      [
        { id: 'repo::/srv/app', hostId: 'runtime:env-1', identityKey: 'wt2:a' },
        {
          id: 'repo::/srv/other',
          hostId: 'ssh:box',
          identityKey: 'wt2:b',
          crossStoreParent: {
            installationId: 'elsewhere',
            workspaceKey: 'folder:hub',
            instanceId: 'i'
          }
        }
      ],
      { owners: context(LOCAL), localInstallationId: 'mine' }
    )
    expect(stamped).toEqual({
      server: null,
      serverUnknown: 'unverified-owner',
      address: {
        server: 'local',
        worktree: 'identity:wt2:a',
        line: '--server local --worktree identity:wt2:a'
      },
      parent: null
    })
    expect(stranger).toMatchObject({
      server: null,
      serverUnknown: 'legacy-ssh-row',
      address: { server: 'local' },
      parent: { state: 'unknown-server', server: null, address: null }
    })
  })
})
