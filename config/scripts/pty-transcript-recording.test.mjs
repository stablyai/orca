import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { tapBunTerminalBytes } from './pty-transcript-bun-runtime.mjs'
import { recordPtyTranscript } from './pty-transcript-recording.mjs'

test('raw tap preserves invalid UTF-8, split UTF-8 and control bytes in both terminal forms', () => {
  for (const inline of [true, false]) {
    let options
    const raw = []
    const decoded = []
    const runtime = {
      Terminal: class {
        constructor(value) {
          options = value
        }
      },
      spawn(_command, value) {
        if (inline) {
          options = value.terminal
        }
      }
    }
    const tapped = tapBunTerminalBytes(runtime, (bytes) => raw.push(bytes))
    const terminal = { data: (_term, bytes) => decoded.push(bytes) }
    tapped.spawn([], { terminal: inline ? terminal : new tapped.Terminal(terminal) })
    for (const bytes of [[0xff, 0xc0], [0xe2], [0x82, 0xac, 0, 27, 13]]) {
      options.data({}, Uint8Array.from(bytes))
    }
    assert.deepEqual(Buffer.concat(raw), Buffer.from([255, 192, 226, 130, 172, 0, 27, 13]))
    assert.equal(decoded.length, 3)
  }
})

function harness({ fastExit = false, stop = false } = {}) {
  const stdin = new PassThrough()
  const chunks = []
  const sink = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk))
      done()
    }
  })
  const output = []
  const writes = []
  let disposed = 0
  return {
    chunks,
    writes,
    get disposed() {
      return disposed
    },
    stdin,
    run: () =>
      recordPtyTranscript({
        sink,
        stdin,
        stdout: { write: (bytes) => output.push(bytes) },
        options: { sends: [], duration: null },
        spawn: async (data) => {
          data(Buffer.from([255, 27, 13]))
          let exit
          const term = {
            onExit(listener) {
              exit = listener
              if (fastExit) {
                listener({ exitCode: 7 })
              }
              return { dispose() {} }
            },
            write: (bytes) => writes.push(bytes),
            kill() {
              data(Buffer.from('SHUTDOWN'))
              exit({ exitCode: 0 })
            },
            destroy() {
              disposed++
            }
          }
          if (!fastExit) {
            setImmediate(() => {
              stdin.write(Buffer.from([0xc3, 0xa9]))
              if (stop) {
                stdin.write(Buffer.from([0x1d]))
              } else {
                data(Buffer.from([0xe2, 0x82, 0xac]))
                exit({ exitCode: 3 })
              }
            })
          }
          return term
        }
      })
  }
}

test('stop freezes transcript before killing while preserving raw input', async () => {
  const fixture = harness({ stop: true })
  assert.equal(await fixture.run(), 0)
  assert.deepEqual(Buffer.concat(fixture.chunks), Buffer.from([255, 27, 13]))
  assert.deepEqual(fixture.writes, [Buffer.from([0xc3, 0xa9])])
  assert.equal(fixture.stdin.listenerCount('data'), 0)
  assert.equal(fixture.disposed, 1)
})

test('natural exit retains final drained output', async () => {
  const fixture = harness()
  assert.equal(await fixture.run(), 3)
  assert.deepEqual(Buffer.concat(fixture.chunks), Buffer.from([255, 27, 13, 226, 130, 172]))
})

test('fast exit replays completion without hanging', async () => {
  const fixture = harness({ fastExit: true })
  assert.equal(await fixture.run(), 7)
  assert.equal(fixture.disposed, 1)
})

test('spawn receipt failure cleans input and closes output', async () => {
  const stdin = new PassThrough()
  const sink = new PassThrough()
  let destroyed = false
  await assert.rejects(
    recordPtyTranscript({
      stdin,
      sink,
      stdout: { write() {} },
      options: { sends: [], duration: null },
      spawn: async () => ({
        onExit() {
          return { dispose() {} }
        },
        waitForSpawn: async () => {
          throw new Error('shell failed')
        },
        destroy() {
          destroyed = true
        }
      })
    }),
    /shell failed/
  )
  assert.equal(destroyed, true)
  assert.equal(sink.writableFinished, true)
  assert.equal(stdin.listenerCount('data'), 0)
})

test('sink failure refuses success and retires terminal', async () => {
  const stdin = new PassThrough()
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('disk full'))
    }
  })
  let exit
  let destroyed = false
  await assert.rejects(
    recordPtyTranscript({
      stdin,
      sink,
      stdout: { write() {} },
      options: { sends: [], duration: null },
      spawn: async (data) => {
        setImmediate(() => data(Buffer.from('output')))
        return {
          onExit(listener) {
            exit = listener
            return { dispose() {} }
          },
          kill() {
            exit({ exitCode: 1 })
          },
          destroy() {
            destroyed = true
          }
        }
      }
    }),
    /disk full/
  )
  assert.equal(destroyed, true)
  assert.equal(stdin.listenerCount('data'), 0)
})
