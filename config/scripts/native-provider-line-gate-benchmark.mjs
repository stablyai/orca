import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Pipe the baseline client module on stdin. Native process/filesystem operations are forbidden here.
const entry = path.resolve('src/main/computer/macos-native-provider-client.ts')
const sources = [readFileSync(0, 'utf8'), readFileSync(entry, 'utf8')]
assert(sources.every((source) => source.includes('export class MacOSNativeProviderClient')))
async function load(source) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'native-client-receive-fixture',
        setup(builder) {
          builder.onLoad({ filter: /macos-native-provider-client\.ts$/ }, () => ({
            contents: `${source}\nexport { NativeProviderLineBuffer, consumeNativeProviderLines } from './macos-native-provider-transport';`,
            loader: 'ts',
            resolveDir: path.dirname(entry)
          }))
          builder.onResolve({ filter: /^node:(fs|child_process)$/ }, (args) => ({
            path: args.path,
            namespace: 'forbidden-native-operation'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'forbidden-native-operation' }, (args) => ({
            contents: `function forbidden() { throw new Error('Native operations are forbidden in this benchmark'); }
            export { forbidden as ${
              args.path === 'node:fs'
                ? 'chmodSync, forbidden as mkdtempSync, forbidden as rmSync, forbidden as writeFileSync, forbidden as existsSync'
                : 'spawn'
            } };`,
            loader: 'js'
          }))
        }
      }
    ]
  })
  const bundled = `${result.outputFiles[0].text}\n//# sourceURL=native-provider-line-gate-benchmark-bundle.js`
  return import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
}
const modules = await Promise.all(sources.map(load))

class FixtureSocket {
  destroyed = false
  writes = []
  write(line) {
    this.writes.push(line)
  }
  end() {
    this.destroyed = true
  }
  destroy() {
    this.destroyed = true
  }
}

function clientFixture(module) {
  const client = new module.MacOSNativeProviderClient()
  const socket = new FixtureSocket()
  client.socket = socket
  return { client, socket, stale: new FixtureSocket(), events: [] }
}

function state(fixture) {
  const { client, socket, events } = fixture
  return {
    buffered:
      typeof client.socketBuffer === 'string' ? client.socketBuffer : client.socketBuffer.pending,
    pending: [...client.pending.keys()],
    active: client.socket === socket,
    generation: client.socketStartGeneration,
    destroyed: socket.destroyed,
    writes: socket.writes,
    events
  }
}

function register(fixture, id, throwCallback) {
  fixture.client.pending.set(id, {
    timer: undefined,
    resolve(value) {
      fixture.events.push(['resolve', id, value])
      if (throwCallback) {
        throw new Error('fixture callback failure')
      }
    },
    reject(error) {
      fixture.events.push(['reject', id, error.code, error.message])
      if (throwCallback) {
        throw new Error('fixture callback failure')
      }
    }
  })
}

let seed = 0x18c0ffee
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return (seed >>> 8) % max
}
for (let trace = 0; trace < 2000; trace++) {
  const fixtures = modules.map(clientFixture)
  let remainder = ''
  for (let step = 0; step < 40; step++) {
    const op = random(20)
    const id = random(8)
    const throwCallback = random(12) === 0
    if (!remainder) {
      remainder = [
        `${JSON.stringify({ id, ok: true, result: { text: 'Unicode 界😀', value: step } })}\n`,
        `${JSON.stringify({ id, ok: false, error: { code: 'fixture', message: 'failed' } })}\r\n`,
        `${JSON.stringify({ id, ok: false })}\n`,
        ' \t\r\n',
        'invalid json\n',
        'null\n',
        '\ud83d\udc00\n'
      ][random(7)]
    }
    const length = random(remainder.length + 1)
    const chunk = remainder.slice(0, length)
    if (op > 5) {
      remainder = remainder.slice(length)
    }
    for (const fixture of fixtures) {
      const { client, socket } = fixture
      try {
        if (op === 0) {
          client.shutdown()
        } else if (op === 1) {
          client.handleSocketClose(socket)
        } else if (op === 2) {
          client.handleTransportError(socket, new Error('fixture transport error'))
        } else if (op === 3) {
          client.invalidateActiveSocketAfterWriteFailure(socket, new Error('fixture write error'))
        } else if (op === 4) {
          fixture.stale = socket
          fixture.socket = new FixtureSocket()
          client.socket = fixture.socket
        } else if (op === 5) {
          register(fixture, id, throwCallback)
        } else {
          client.handleSocketData(op === 6 ? fixture.stale : socket, chunk)
        }
      } catch (error) {
        fixture.events.push(['throw', error.name, error.message])
      }
    }
    assert.deepEqual(state(fixtures[1]), state(fixtures[0]))
  }
}
console.log('2,000 actual client receive/lifecycle traces / 80,000 commands match')

for (let trace = 0; trace < 1000; trace++) {
  const fixtures = modules.map(clientFixture)
  const failThird = random(2) === 0
  for (const fixture of fixtures) {
    for (let id = 1; id <= 4; id++) {
      register(fixture, id, id === 3 && failThird)
    }
  }
  const input = [
    JSON.stringify({ id: 1, ok: true, result: { text: `界😀 ${trace}` } }),
    JSON.stringify({ id: 2, ok: false, error: { code: 'fixture', message: 'failed' } }),
    JSON.stringify({ id: 3, ok: true, result: trace }),
    JSON.stringify({ id: 4, ok: true, result: 'final reply' }),
    ''
  ].join('\n')
  let offset = 0
  while (offset < input.length) {
    const length = 1 + random(80)
    const chunk = input.slice(offset, offset + length)
    offset += length
    for (const fixture of fixtures) {
      try {
        fixture.client.handleSocketData(fixture.socket, chunk)
      } catch (error) {
        fixture.events.push(['throw', error.name, error.message])
      }
    }
    assert.deepEqual(state(fixtures[1]), state(fixtures[0]))
  }
  for (const fixture of fixtures) {
    fixture.client.handleSocketData(fixture.socket, '')
    assert.equal(fixture.client.pending.size, 0)
    assert.deepEqual(fixture.events.at(-1), ['resolve', 4, 'final reply'])
  }
  assert.deepEqual(state(fixtures[1]), state(fixtures[0]))
}
console.log('1,000 fragmented multi-reply client journeys / 4,000 request settlements match')

class BaselineBuffer {
  pending = ''
  push(chunk, onLine) {
    this.pending += chunk
    this.pending = modules[0].consumeNativeProviderLines(this.pending, onLine)
  }
  clear() {
    this.pending = ''
  }
}
for (let trace = 0; trace < 3000; trace++) {
  const buffers = [new BaselineBuffer(), new modules[1].NativeProviderLineBuffer()]
  const events = [[], []]
  for (let step = 0; step < 30; step++) {
    const clear = random(25) === 0
    const fail = random(10) === 0
    const chunk = ['abc', '\n', '\r\n', '\ud83d', '\udc00', '\n\n', '界', '', 'ok\nfault\npartial'][
      random(9)
    ]
    buffers.forEach((buffer, index) => {
      if (clear) {
        buffer.clear()
      }
      try {
        buffer.push(chunk, (line) => {
          events[index].push(line)
          if (fail) {
            throw new Error('fixture callback failure')
          }
        })
      } catch (error) {
        events[index].push({ error: error.message })
      }
    })
    assert.deepEqual(events[1], events[0])
    assert.equal(buffers[1].pending, buffers[0].pending)
  }
}
console.log('3,000 actual line-buffer traces / 90,000 feeds match')

function receiveArm(module) {
  const fixture = clientFixture(module)
  return (chunks) => {
    let result
    fixture.client.pending.set(1, {
      timer: undefined,
      resolve: (value) => {
        result = value
      },
      reject: (error) => {
        throw error
      }
    })
    for (const chunk of chunks) {
      fixture.client.handleSocketData(fixture.socket, chunk)
    }
    return result
  }
}
function sample(arm, input, repeats) {
  const start = performance.now()
  let result
  for (let i = 0; i < repeats; i++) {
    result = arm(input)
  }
  return { elapsed: (performance.now() - start) / repeats, result }
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    unit: 'ms',
    pairs: 8
  })
)
for (const [size, chunkBytes] of [
  [64, 65536],
  [120000, 65536],
  [1200000, 65536],
  [1200000, 4096],
  [4800000, 65536],
  [1200000, Number.POSITIVE_INFINITY]
]) {
  const expected = { screenshot: { data: 'A'.repeat(size) }, text: 'fixture' }
  const input = `${JSON.stringify({ id: 1, ok: true, result: expected })}\n`
  const chunks = []
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    chunks.push(input.slice(offset, offset + chunkBytes))
  }
  const arms = modules.map(receiveArm)
  for (const arm of arms) {
    assert.deepEqual(arm(chunks), expected)
    const until = performance.now() + 150
    while (performance.now() < until) {
      sample(arm, chunks, 1)
    }
  }
  const repeats = Math.max(3, Math.min(100000, Math.ceil(50 / sample(arms[0], chunks, 1).elapsed)))
  /** @type {number[][]} */
  const times = [[], []]
  for (let pair = 0; pair < 8; pair++) {
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      const result = sample(arms[index], chunks, repeats)
      assert.deepEqual(result.result, expected)
      times[index].push(result.elapsed)
    }
  }
  const median = times.map((values) => {
    values.sort((a, b) => a - b)
    return (values[3] + values[4]) / 2
  })
  console.log(
    JSON.stringify({
      size,
      chunkBytes: Number.isFinite(chunkBytes) ? chunkBytes : 'whole frame',
      chunks: chunks.length,
      repeats,
      median,
      times
    })
  )
}
