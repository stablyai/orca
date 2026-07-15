import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const { acquireMock, gitExecFileAsyncMock, glabExecFileAsyncMock, releaseMock } = vi.hoisted(
  () => ({
    acquireMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    glabExecFileAsyncMock: vi.fn(),
    releaseMock: vi.fn()
  })
)

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    acquire: acquireMock,
    glabExecFileAsync: glabExecFileAsyncMock,
    release: releaseMock
  }
})

import {
  _resetKnownHostsCache,
  _resetProjectRefCache,
  getProjectRefForRemote,
  type ProjectRef
} from './gl-utils'
import { updateIssue } from './issues'
import { getWorkItemDetails } from './work-item-details'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

const CONNECTION_ID = 'conn-lifecycle'

function blockAtGitLabApiBoundary(): { atBoundary: Promise<void>; continueOperation: () => void } {
  let continueOperation = (): void => {}
  let reachedBoundary = (): void => {}
  const atBoundary = new Promise<void>((resolve) => {
    reachedBoundary = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    continueOperation = resolve
  })
  acquireMock.mockImplementationOnce(() => {
    reachedBoundary()
    return blocked
  })
  return { atBoundary, continueOperation }
}

async function resolveTransportedProjectRef(oldProviderExec: ReturnType<typeof vi.fn>) {
  registerSshGitProvider(CONNECTION_ID, { exec: oldProviderExec } as never)
  const projectRef = await getProjectRefForRemote('/repo', 'origin', ['gitlab.com'], CONNECTION_ID)
  expect(projectRef).not.toBeNull()
  expect(projectRef).toMatchObject({
    sshConnectionLease: {
      connectionId: CONNECTION_ID,
      providerRegistrationId: expect.any(Number)
    }
  })
  // Why: JSON cloning matches the renderer/RPC round trip that used to drop
  // process-local WeakMap provenance before a later read or mutation.
  return JSON.parse(JSON.stringify(projectRef)) as ProjectRef
}

describe('GitLab project ref SSH lifecycle', () => {
  beforeEach(() => {
    acquireMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    releaseMock.mockReset()
    _resetKnownHostsCache()
    _resetProjectRefCache()
    unregisterSshGitProvider(CONNECTION_ID)
    glabExecFileAsyncMock.mockResolvedValue({
      stdout: 'Logged in to gitlab.com as user\n',
      stderr: ''
    })
  })

  afterEach(() => unregisterSshGitProvider(CONNECTION_ID))

  it('aborts a transported read when SSH changes before the API call', async () => {
    const oldProviderExec = vi.fn().mockResolvedValue({
      stdout: 'git@gitlab.com:old/project.git\n',
      stderr: ''
    })
    const replacementProviderExec = vi.fn()
    const projectRef = await resolveTransportedProjectRef(oldProviderExec)
    const { atBoundary, continueOperation } = blockAtGitLabApiBoundary()

    const operation = getWorkItemDetails('/repo', 7, 'issue', undefined, CONNECTION_ID, projectRef)
    await atBoundary
    unregisterSshGitProvider(CONNECTION_ID)
    registerSshGitProvider(CONNECTION_ID, { exec: replacementProviderExec } as never)
    glabExecFileAsyncMock.mockClear()
    glabExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ iid: 7, title: 'stale', state: 'opened' }),
      stderr: ''
    })
    continueOperation()

    await expect(operation).resolves.toBeNull()
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(replacementProviderExec).not.toHaveBeenCalled()
  })

  it('aborts a transported write when SSH changes before the API call', async () => {
    const oldProviderExec = vi.fn().mockResolvedValue({
      stdout: 'git@gitlab.com:old/project.git\n',
      stderr: ''
    })
    const replacementProviderExec = vi.fn()
    const projectRef = await resolveTransportedProjectRef(oldProviderExec)
    const { atBoundary, continueOperation } = blockAtGitLabApiBoundary()

    const operation = updateIssue(
      '/repo',
      8,
      { title: 'Do not send' },
      undefined,
      CONNECTION_ID,
      projectRef
    )
    await atBoundary
    unregisterSshGitProvider(CONNECTION_ID)
    registerSshGitProvider(CONNECTION_ID, { exec: replacementProviderExec } as never)
    glabExecFileAsyncMock.mockClear()
    continueOperation()

    await expect(operation).resolves.toMatchObject({ ok: false })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(replacementProviderExec).not.toHaveBeenCalled()
  })

  it('rechecks field edits after waiting at the API boundary', async () => {
    const oldProviderExec = vi.fn().mockResolvedValue({
      stdout: 'git@gitlab.com:old/project.git\n',
      stderr: ''
    })
    const replacementProviderExec = vi.fn()
    registerSshGitProvider(CONNECTION_ID, { exec: oldProviderExec } as never)
    const { atBoundary, continueOperation } = blockAtGitLabApiBoundary()

    const operation = updateIssue('/repo', 9, { title: 'Do not send' }, 'origin', CONNECTION_ID)
    await atBoundary
    unregisterSshGitProvider(CONNECTION_ID)
    registerSshGitProvider(CONNECTION_ID, { exec: replacementProviderExec } as never)
    glabExecFileAsyncMock.mockClear()
    continueOperation()

    await expect(operation).resolves.toMatchObject({ ok: false })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(replacementProviderExec).not.toHaveBeenCalled()
  })
})
