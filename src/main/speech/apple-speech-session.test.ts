import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnProcess } = vi.hoisted(() => ({ spawnProcess: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess }))
vi.mock('./apple-speech-helper-binary', () => ({
  getAppleSpeechHelperPath: () => '/Applications/Orca.app/Contents/MacOS/orca-speech-transcriber'
}))

import { AppleSpeechSession } from './apple-speech-session'

type FakeHelper = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  kill: () => void
}

function createFakeHelper(): FakeHelper {
  const child: FakeHelper = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    kill: vi.fn()
  })
  child.kill = vi.fn(() => {
    child.exitCode = 0
    child.emit('close')
  })
  return child
}

describe('AppleSpeechSession', () => {
  let helper: FakeHelper

  beforeEach(() => {
    helper = createFakeHelper()
    spawnProcess.mockReset()
    spawnProcess.mockReturnValue(helper)
  })

  async function startSession(
    emit = vi.fn()
  ): Promise<{ session: AppleSpeechSession; emit: typeof emit }> {
    const session = new AppleSpeechSession(emit)
    const started = session.start()
    helper.stdout.write('{"type":"ready","locale":"en-US"}\n')
    await started
    return { session, emit }
  }

  it('waits for the helper to report readiness before accepting audio', async () => {
    const { session } = await startSession()
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['transcribe', '--sample-rate', '16000'] })
    )
    expect(session).toBeInstanceOf(AppleSpeechSession)
  })

  it('fails the start when the helper reports its assets are missing', async () => {
    const session = new AppleSpeechSession(vi.fn())
    const started = session.start()
    helper.stdout.write('{"type":"error","error":"assets_not_installed"}\n')

    await expect(started).rejects.toThrow('not installed')
    expect(helper.kill).toHaveBeenCalled()
  })

  it('forwards partial and final segments as the user speaks', async () => {
    const { emit } = await startSession()

    helper.stdout.write(
      '{"type":"partial","text":"hello th"}\n{"type":"final","text":"Hello there."}\n'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(emit).toHaveBeenNthCalledWith(1, { type: 'partial', text: 'hello th' })
    expect(emit).toHaveBeenNthCalledWith(2, { type: 'final', text: 'Hello there.' })
  })

  it('resamples microphone audio to the rate the helper was told to expect', async () => {
    const { session } = await startSession()
    const written: Buffer[] = []
    helper.stdin.on('data', (chunk: Buffer) => written.push(chunk))

    session.feedAudio(new Float32Array(480), 48000)
    await new Promise((resolve) => setImmediate(resolve))

    expect(Buffer.concat(written).byteLength).toBe(160 * 4)
  })

  it('drains the helper on finish and reports no trailing text of its own', async () => {
    const { session } = await startSession()
    const finished = session.finish()
    helper.stdout.write('{"type":"stopped"}\n')
    helper.exitCode = 0
    helper.emit('close')

    await expect(finished).resolves.toBe('')
  })

  it('reports an exit the user did not ask for, so the UI leaves listening', async () => {
    const { emit } = await startSession()

    helper.exitCode = 1
    helper.emit('close')

    expect(emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'Apple Speech stopped unexpectedly.'
    })
  })

  it('stays quiet when the exit is the one finish asked for', async () => {
    const { session, emit } = await startSession()
    const finished = session.finish()
    helper.exitCode = 0
    helper.emit('close')
    await finished

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
  })

  it('does not double-report a failure the helper already explained', async () => {
    const { emit } = await startSession()

    helper.stdout.write('{"type":"error","error":"transcription_failed","detail":"boom"}\n')
    await new Promise((resolve) => setImmediate(resolve))
    helper.exitCode = 1
    helper.emit('close')

    const errors = emit.mock.calls.filter(([event]) => event.type === 'error')
    expect(errors).toHaveLength(1)
  })

  it('ends the dictation when transcripts stop flowing over a broken pipe', async () => {
    const { emit } = await startSession()

    helper.stdout.emit('error', new Error('EIO'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(helper.kill).toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'Apple Speech stopped unexpectedly.'
    })
  })

  it('stops accepting audio once the helper is gone', async () => {
    const { session } = await startSession()
    helper.exitCode = 0
    helper.emit('close')

    await expect(session.finish()).resolves.toBe('')
    expect(() => session.feedAudio(new Float32Array(16), 16000)).not.toThrow()
  })
})
