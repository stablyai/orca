import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { markRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import {
  beginFolderComposerSubmission,
  createFolderRepoWorktree,
  isFolderRepoCreateBusy,
  reconcileFolderRepoCreates,
  releaseFolderComposerReservation,
  type FolderRepoTarget
} from './folder-repo-worktree-create'

const idempotency = vi.hoisted(() => {
  const state: { support: { dedupeTtlMs: number } | false } = { support: false }
  return state
})
vi.mock('../../tasks/worktree-create-capability', () => ({
  readNewWorktreeRuntimeCapabilities: async () => ({
    worktreeCreateIdempotency: idempotency.support
  })
}))

const FOLDER = 'folder:f-1'
const TAKEN = 'Branch payments already exists\nworktree_create_exact_name_taken'

afterEach(() => {
  vi.useRealTimers()
  idempotency.support = false
})

let repoCount = 0
// Each test's own repository: the registry is shared, as it is across screens.
function target(executionHost?: string): FolderRepoTarget {
  repoCount += 1
  return { hostId: 'host-1', executionHost, folderWorktreeId: FOLDER, repoId: `repo-${repoCount}` }
}

function refused(message: string): RpcResponse {
  return { id: '1', ok: false, error: { code: 'x', message }, _meta: { runtimeId: 'r' } }
}

const CREATED: RpcResponse = {
  id: '1',
  ok: true,
  result: { worktree: { id: 'repo::/w/payments', displayName: 'payments' } },
  _meta: { runtimeId: 'r' }
}

function host(...replies: (RpcResponse | Error)[]): FakeSession {
  const client = new FakeSession('connected')
  for (const reply of replies) {
    if (reply instanceof Error) {
      client.sendRequest.mockRejectedValueOnce(reply)
    } else {
      client.sendRequest.mockResolvedValueOnce(reply)
    }
  }
  return client
}

const create = (repo: FolderRepoTarget, client: FakeSession) =>
  createFolderRepoWorktree({ target: repo, client, name: 'payments' })

describe('createFolderRepoWorktree', () => {
  it('sends one exact-name create attached to the folder', async () => {
    const repo = target()
    const client = host(CREATED)

    await expect(create(repo, client)).resolves.toEqual({ kind: 'created', name: 'payments' })
    expect(client.sendRequest.mock.calls).toEqual([
      [
        'worktree.create',
        {
          repo: `id:${repo.repoId}`,
          name: 'payments',
          displayName: 'payments',
          displayNameKind: 'user',
          branchIntent: 'create-exact',
          setupDecision: 'inherit',
          parentWorkspace: FOLDER,
          parentWorkspaceOrigin: 'manual'
        },
        expect.anything()
      ]
    ])
  })

  it('sends nothing for a second tap while the first create runs', async () => {
    const repo = target()
    const client = new FakeSession('connected')
    let answer: (response: RpcResponse) => void = () => {}
    client.sendRequest.mockReturnValue(new Promise<RpcResponse>((resolve) => (answer = resolve)))

    const first = create(repo, client)
    await expect(create(repo, client)).resolves.toEqual({ kind: 'already-running' })
    answer(CREATED)
    await first
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the name is taken', TAKEN],
    ['the repo asks about setup', 'Setup decision required for this repository']
  ])('keeps the repository for the composer when %s', async (_case, message) => {
    const repo = target()
    const outcome = await create(repo, host(refused(message)))

    expect(outcome.kind).toBe('needs-composer')
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
    if (outcome.kind === 'needs-composer') {
      releaseFolderComposerReservation(repo, outcome.reservation)
    }
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
  })

  it('treats a lost reply as possibly created, past the busy backstop, and never offers the composer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const repo = target()
    const lost = markRpcDeliveryUnknown(new Error('connection lost'))

    await expect(create(repo, host(lost))).resolves.toEqual({ kind: 'maybe-created' })
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
    await expect(create(repo, host(CREATED))).resolves.toEqual({ kind: 'already-running' })

    // The list never showed it; the card takes taps again but the create is still unresolved.
    vi.advanceTimersByTime(60_000)
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
    const retry = host(refused(TAKEN))
    await expect(create(repo, retry)).resolves.toEqual({ kind: 'maybe-created' })
    expect(retry.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('retries an unconfirmed create as the name it was sent as, even after the folder is renamed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const repo = target()
    await create(repo, host(markRpcDeliveryUnknown(new Error('connection lost'))))
    vi.advanceTimersByTime(60_000)

    const retry = host(refused(TAKEN))
    await createFolderRepoWorktree({ target: repo, client: retry, name: 'billing' })
    expect(retry.sendRequest.mock.calls[0]?.[1]).toMatchObject({ name: 'payments' })
  })

  it('asks for setup when an unconfirmed create is refused for it, and resends the same exact name', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const repo = target()
    await create(repo, host(markRpcDeliveryUnknown(new Error('connection lost'))))
    vi.advanceTimersByTime(60_000)

    const asked = await create(repo, host(refused('Setup decision required for this repository')))
    expect(asked.kind).toBe('needs-setup-choice')
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
    const hold = asked.kind === 'needs-setup-choice' ? asked.hold : -1

    const resent = host(refused(TAKEN))
    await expect(
      createFolderRepoWorktree({
        target: repo,
        client: resent,
        name: 'billing',
        skipSetupFor: hold
      })
    ).resolves.toEqual({ kind: 'maybe-created' })
    expect(resent.sendRequest.mock.calls[0]?.[1]).toMatchObject({
      name: 'payments',
      branchIntent: 'create-exact',
      setupDecision: 'skip'
    })
  })

  it('sends nothing for a setup choice once its create is listed or replaced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const ask = async (repo: FolderRepoTarget) => {
      await create(repo, host(markRpcDeliveryUnknown(new Error('connection lost'))))
      vi.advanceTimersByTime(60_000)
      const asked = await create(repo, host(refused('Setup decision required for this repository')))
      return asked.kind === 'needs-setup-choice' ? asked.hold : -1
    }
    const listed = target()
    const listedHold = await ask(listed)
    const folder = { hostId: 'host-1', executionHost: undefined, folderWorktreeId: FOLDER }
    reconcileFolderRepoCreates(folder, [{ repoId: listed.repoId }])
    const replaced = target()
    const replacedHold = await ask(replaced)
    await ask(replaced)

    const late = host(CREATED)
    for (const [repo, hold] of [
      [listed, listedHold],
      [replaced, replacedHold]
    ] as const) {
      await expect(
        createFolderRepoWorktree({
          target: repo,
          client: late,
          name: 'billing',
          skipSetupFor: hold
        })
      ).resolves.toEqual({ kind: 'checking' })
    }
    expect(late.sendRequest).not.toHaveBeenCalled()
  })
})

describe('createFolderRepoWorktree after a lost reply on a host that dedupes', () => {
  it.each([
    ['answers with the worktree', CREATED, { kind: 'created', name: 'payments' }],
    ['refuses the name as taken', refused(TAKEN), { kind: 'maybe-created' }]
  ])('resends the same create once reconnected; the host %s', async (_case, replay, expected) => {
    idempotency.support = { dedupeTtlMs: 60_000 }
    const repo = target()
    const client = new FakeSession('connected')
    client.sendRequest
      .mockImplementationOnce(async () => {
        client.publishState('reconnecting')
        setTimeout(() => client.publishState('connected'), 0)
        throw markRpcDeliveryUnknown(new Error('connection lost'))
      })
      .mockResolvedValueOnce(replay)

    await expect(create(repo, client)).resolves.toEqual(expected)
    const [first, second] = client.sendRequest.mock.calls.map(([, params]) => params)
    expect(second).toEqual(first)
    expect(first).toHaveProperty('clientMutationId')
  })
})

describe('reconcileFolderRepoCreates', () => {
  it('forgets a create once the folder lists its worktree on the same host, not another', async () => {
    const repo = target('runtime:env-1')
    await create(repo, host(CREATED))
    const folder = { hostId: 'host-1', executionHost: 'runtime:env-1', folderWorktreeId: FOLDER }

    reconcileFolderRepoCreates(folder, [{ repoId: repo.repoId, hostId: 'runtime:env-2' }])
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
    reconcileFolderRepoCreates(folder, [{ repoId: repo.repoId, hostId: 'runtime:env-1' }])
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
  })

  it('keeps a create still on its way even if the list already shows the repository', async () => {
    const repo = target()
    const client = new FakeSession('connected')
    let answer: (response: RpcResponse) => void = () => {}
    client.sendRequest.mockReturnValue(new Promise<RpcResponse>((resolve) => (answer = resolve)))
    const folder = { hostId: 'host-1', executionHost: undefined, folderWorktreeId: FOLDER }
    const members = [{ repoId: repo.repoId }]

    const pending = create(repo, client)
    reconcileFolderRepoCreates(folder, members)
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
    answer(CREATED)
    await pending
    reconcileFolderRepoCreates(folder, members)
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
  })

  it("doesn't let an earlier create's timer end a newer one", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const repo = target()
    await create(repo, host(markRpcDeliveryUnknown(new Error('lost'))))
    vi.advanceTimersByTime(10_000)
    const folder = { hostId: 'host-1', executionHost: undefined, folderWorktreeId: FOLDER }
    reconcileFolderRepoCreates(folder, [{ repoId: repo.repoId }])
    await create(repo, host(CREATED))

    vi.advanceTimersByTime(10_000)
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
  })
})

describe('beginFolderComposerSubmission', () => {
  async function composing() {
    const repo = target()
    const outcome = await create(repo, host(refused(TAKEN)))
    if (outcome.kind !== 'needs-composer') {
      throw new Error('expected the composer')
    }
    return { repo, launch: { target: repo, reservation: outcome.reservation, name: 'payments' } }
  }

  it('admits one create per repository while it is out, even after the form closes', async () => {
    const { repo, launch } = await composing()
    let formOpen = true
    const submission = beginFolderComposerSubmission(repo, launch, () => formOpen)

    expect(submission).not.toBeNull()
    formOpen = false
    releaseFolderComposerReservation(repo, launch.reservation)
    expect(beginFolderComposerSubmission(repo, launch, () => true)).toBeNull()
    expect(await create(repo, host(CREATED))).toEqual({ kind: 'already-running' })

    submission?.settle('uncertain')
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
  })

  it('gives a refused create back to the open form, and a same-host switch its own admission', async () => {
    const { repo, launch } = await composing()
    const other = { ...repo, repoId: `${repo.repoId}-other` }

    beginFolderComposerSubmission(repo, launch, () => true)?.settle('failed')
    expect(isFolderRepoCreateBusy(repo)).toBe(true)
    const switched = beginFolderComposerSubmission(other, launch, () => true)
    expect(switched).not.toBeNull()
    expect(beginFolderComposerSubmission(other, launch, () => true)).toBeNull()
    switched?.settle('created')
    releaseFolderComposerReservation(repo, launch.reservation)
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
    expect(isFolderRepoCreateBusy(other)).toBe(true)
  })
  it("never sends anything from a card for a form's unconfirmed create, whatever name it used", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { repo, launch } = await composing()
    // The form may have sent another name or branch than the card's.
    beginFolderComposerSubmission(repo, launch, () => true)?.settle('uncertain')
    vi.advanceTimersByTime(60_000)

    expect(beginFolderComposerSubmission(repo, launch, () => true)).toBeNull()
    const tap = host(CREATED)
    await expect(create(repo, tap)).resolves.toEqual({ kind: 'checking' })
    await expect(
      createFolderRepoWorktree({
        target: repo,
        client: tap,
        name: 'payments',
        skipSetupFor: 0
      })
    ).resolves.toEqual({ kind: 'checking' })
    expect(tap.sendRequest).not.toHaveBeenCalled()
    expect(isFolderRepoCreateBusy(repo)).toBe(false)
  })
})
