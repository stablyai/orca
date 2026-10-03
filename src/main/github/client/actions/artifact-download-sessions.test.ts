import { afterEach, expect, it, vi } from 'vitest'
import {
  artifactSessionOwner,
  createArtifactSession,
  readArtifactSession,
  releaseArtifactSession
} from './artifact-download-sessions'
import { ACTIONS_ARTIFACT_CHUNK_BYTES } from '../../../../shared/github/actions-artifact-types'
import { EventEmitter } from 'node:events'
import { abortWhenRendererGone } from '../../../ipc/renderer-lifetime-abort'
afterEach(() => vi.useRealTimers())
it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
  'releases only the dead renderer’s transfer on %s without evicting active transfers',
  (event) => {
    const renderer = new EventEmitter()
    const lifetime = abortWhenRendererGone({
      once: (event, listener) => {
        renderer.once(event, listener)
        return Object.create(null)
      },
      removeListener: (event, listener) => {
        renderer.removeListener(event, listener)
        return Object.create(null)
      }
    })
    const dispose = vi.fn(lifetime.dispose)
    const abandoned = createArtifactSession(
      'a',
      Buffer.from('ZIP'),
      'a.zip',
      lifetime.signal,
      dispose
    )
    const active = createArtifactSession('b', Buffer.from('live'), 'b.zip')
    expect(() => createArtifactSession('c', Buffer.from('new'), 'c.zip')).toThrow('Finish another')
    renderer.emit(event)
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => readArtifactSession(abandoned.transferId, 'a', 0)).toThrow('expired')
    expect(readArtifactSession(active.transferId, 'b', 0).contentBase64).toBe(
      Buffer.from('live').toString('base64')
    )
    const next = createArtifactSession('c', Buffer.from('new'), 'c.zip')
    releaseArtifactSession(active.transferId, 'b')
    releaseArtifactSession(next.transferId, 'c')
    expect(renderer.listenerCount('destroyed')).toBe(0)
  }
)
it('cleans up retained lifetime listeners exactly once on explicit release or expiry', () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const dispose = vi.fn()
  const first = createArtifactSession('a', Buffer.from('ZIP'), 'a.zip', controller.signal, dispose)
  releaseArtifactSession(first.transferId, 'a')
  controller.abort()
  expect(dispose).toHaveBeenCalledOnce()
  const expires = vi.fn()
  createArtifactSession('b', Buffer.from('ZIP'), 'b.zip', undefined, expires)
  vi.advanceTimersByTime(5 * 60_000)
  expect(expires).toHaveBeenCalledOnce()
})
it('bounds chunks, binds downloads to the repository/account/host and expires abandoned sessions', () => {
  vi.useFakeTimers()
  const owner = artifactSessionOwner('/repo', 'ssh-a', {
    ghAccount: { host: 'github.com', user: 'a' }
  })
  const changed = artifactSessionOwner('/repo', 'ssh-a', {
    ghAccount: { host: 'github.com', user: 'b' }
  })
  const archive = Buffer.alloc(ACTIONS_ARTIFACT_CHUNK_BYTES + 10, 7)
  const transfer = createArtifactSession(owner, archive, 'report.zip')
  expect(() => readArtifactSession(transfer.transferId, changed, 0)).toThrow('owner changed')
  expect(() => releaseArtifactSession(transfer.transferId, changed)).toThrow('owner changed')
  const first = readArtifactSession(transfer.transferId, owner, 0)
  expect(Buffer.from(first.contentBase64, 'base64')).toHaveLength(ACTIONS_ARTIFACT_CHUNK_BYTES)
  expect(first.done).toBe(false)
  expect(readArtifactSession(transfer.transferId, owner, first.nextOffset).done).toBe(true)
  expect(() => readArtifactSession(transfer.transferId, owner, -1)).toThrow('offset')
  vi.advanceTimersByTime(5 * 60_000)
  expect(() => readArtifactSession(transfer.transferId, owner, 0)).toThrow('expired')
})
