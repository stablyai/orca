import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { observeProviderLeaderOutcome } from './provider-leader-outcome'

function parent() {
  const raw = new ChildProcess()
  const pipe = new PassThrough()
  raw.pid = 9_999_999
  raw.stdio = [null, null, null, null, null, null, pipe]
  return { raw, pipe }
}

describe('provider leader wait evidence', () => {
  it.each([
    { code: 0, signal: null },
    { code: 71, signal: null },
    { code: null, signal: 'SIGUSR1' }
  ])('leaves the CLI outcome unknown after parent exit %j without a frame', async (status) => {
    const { raw, pipe } = parent()
    const outcome = observeProviderLeaderOutcome(raw)
    raw.emit('exit', status.code, status.signal)
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

  it.each(['{"code":0,"signal":null}', 'invalid\n'])(
    'does not treat invalid wait evidence %j as a CLI exit',
    async (frame) => {
      const { raw, pipe } = parent()
      const outcome = observeProviderLeaderOutcome(raw)
      pipe.end(frame)
      raw.emit('exit', 0, null)
      await expect(outcome).resolves.toBeNull()
    }
  )

  it('preserves processless spawn failure close status', async () => {
    const { raw, pipe } = parent()
    raw.pid = undefined
    const outcome = observeProviderLeaderOutcome(raw)
    pipe.destroy()
    raw.emit('close', -2, null)
    await expect(outcome).resolves.toEqual({ code: -2, signal: null })
  })
})
