import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { observeProviderLeaderOutcome } from './provider-leader-outcome'

function parent() {
  const raw = createFakeSpawnedChild(9_999_999)
  const pipe = new PassThrough()
  raw.stdio.push(null, pipe)
  return { raw, pipe }
}

describe('provider leader wait evidence', () => {
  it('leaves the CLI outcome unknown after parent exit without a frame', async () => {
    const { raw, pipe } = parent()
    const outcome = observeProviderLeaderOutcome(raw)
    raw.emit('exit', null, 'SIGUSR1')
    pipe.end()
    await expect(outcome).resolves.toBeNull()
  })

  it('waits for buffered CLI evidence after parent exit instead of using its status', async () => {
    const { raw, pipe } = parent()
    const outcome = observeProviderLeaderOutcome(raw)
    raw.emit('exit', null, 'SIGUSR1')
    pipe.end('{"code":23,"signal":null}\n')
    await expect(outcome).resolves.toEqual({ code: 23, signal: null })
  })

  it('reports the real CLI outcome while its parent remains alive', async () => {
    const { raw, pipe } = parent()
    const outcome = observeProviderLeaderOutcome(raw)
    pipe.end('{"code":null,"signal":15}\n')
    await expect(outcome).resolves.toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('settles truncated evidence while the native parent remains live', async () => {
    const { raw, pipe } = parent()
    const outcome = observeProviderLeaderOutcome(raw)
    pipe.end('{"code":0,"signal":null}')
    await expect(outcome).resolves.toBeNull()
    expect(raw.exitCode).toBeNull()
  })

  it('settles a broken outcome pipe while the native parent remains live', async () => {
    const { raw, pipe } = parent()
    const outcome = observeProviderLeaderOutcome(raw)
    pipe.destroy(new Error('broken outcome pipe'))
    await expect(outcome).resolves.toBeNull()
    expect(raw.exitCode).toBeNull()
  })

  it('preserves processless spawn failure close status', async () => {
    const { raw, pipe } = parent()
    Object.defineProperty(raw, 'pid', { value: undefined })
    const outcome = observeProviderLeaderOutcome(raw)
    pipe.destroy()
    raw.emit('close', -2, null)
    await expect(outcome).resolves.toEqual({ code: -2, signal: null })
  })
})
