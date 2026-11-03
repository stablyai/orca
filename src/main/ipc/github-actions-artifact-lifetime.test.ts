import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActionsRequestContext } from '../../shared/github/actions-types'
import type {
  ActionsArtifactTransfer,
  ActionsArtifactDownloadQuery
} from '../../shared/github/actions-artifact-types'

type ArtifactHandler = (
  event: { sender: EventEmitter },
  args: ActionsRequestContext & ActionsArtifactDownloadQuery
) => Promise<ActionsArtifactTransfer>
import {
  createArtifactSession,
  readArtifactSession,
  releaseArtifactSession
} from '../github/client/actions/artifact-download-sessions'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, ArtifactHandler>(),
  start: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: ArtifactHandler) => mocks.handlers.set(name, handler)
  }
}))
vi.mock('./github-actions-repo-routing', () => ({
  registeredActionsRepo: () => ({ path: '/repo' })
}))
vi.mock('./github-repo-routing', () => ({ getGitHubLocalGitOptionArgs: () => [{}] }))
vi.mock('../github/client/actions/actions-artifacts', () => ({
  listActionsArtifacts: vi.fn(),
  startActionsArtifactDownload: mocks.start
}))
import { registerGitHubActionsArtifactHandlers } from './github-actions-artifact-handlers'

afterEach(() => mocks.start.mockReset())
it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
  'keeps renderer cleanup live after start returns until %s',
  async (event) => {
    registerGitHubActionsArtifactHandlers(Object.create(null))
    const sender = new EventEmitter()
    mocks.start.mockImplementation(async (_repo, _query, _connection, _options, signal, dispose) =>
      createArtifactSession('owner', Buffer.from('fixture ZIP'), 'fixture.zip', signal, dispose)
    )
    const handler = mocks.handlers.get('gh:startActionsArtifactDownload')
    if (!handler) {
      throw new Error('Missing handler')
    }
    const transfer = await handler(
      { sender },
      {
        repoId: 'repo',
        repoPath: '/repo',
        repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
        runId: 1,
        artifactId: 1
      }
    )
    try {
      expect(sender.listenerCount('destroyed')).toBe(1)
      sender.emit(event)
      expect(() => readArtifactSession(transfer.transferId, 'owner', 0)).toThrow('expired')
      expect(sender.listenerCount('destroyed')).toBe(0)
    } finally {
      releaseArtifactSession(transfer.transferId, 'owner')
    }
  }
)
