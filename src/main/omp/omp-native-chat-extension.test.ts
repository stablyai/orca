import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { expect, it } from 'vitest'

function extension() {
  const frames: { method: string; params: unknown }[] = []
  const hooks = new Map<string, (event: unknown, context: unknown) => void>()
  let now = 0
  const module = { exports: {} as { default: (api: unknown) => void } }
  const code = transformSync(
    readFileSync(
      new URL('../../../resources/native-chat-visuals/omp-native-chat.mjs', import.meta.url),
      'utf8'
    ),
    { format: 'cjs', platform: 'node' }
  ).code
  runInNewContext(code, {
    module,
    exports: module.exports,
    process: { argv: ['omp', 'acp'] },
    performance: { now: () => now },
    require: (name: string) => {
      if (name === 'node:fs') {
        return { writeSync: (_fd: number, frame: string) => frames.push(JSON.parse(frame)) }
      }
      if (name === '@oh-my-pi/pi-ai') {
        return { serviceTierFamily: () => undefined }
      }
      if (name === '@oh-my-pi/pi-coding-agent/config/service-tier') {
        return {}
      }
      throw new Error(`Unexpected module ${name}`)
    }
  })
  module.exports.default({
    on: (name: string, hook: (event: unknown, context: unknown) => void) => hooks.set(name, hook),
    registerCommand: () => {}
  })
  return {
    frames,
    at: (time: number) => {
      now = time
    },
    emit: (name: string, event = {}, kind = 'main') => hooks.get(name)?.(event, { agent: { kind } })
  }
}

it('publishes cumulative native counters before agent_end despite synthetic zero-token notices', () => {
  const native = extension()
  native.emit('agent_start')
  native.emit('message_end', { message: { role: 'assistant', usage: { output: 0 } } })
  native.emit('message_end', {
    message: { role: 'assistant', usage: { output: 84 }, duration: 2_000 }
  })
  expect(native.frames).toMatchObject([
    { method: '_orca/omp/generation', params: { outputTokens: 84, durationMs: 2_000 } }
  ])
  native.emit(
    'message_end',
    { message: { role: 'assistant', usage: { output: 999 }, duration: 1 } },
    'sub'
  )
  native.emit('message_end', {
    message: { role: 'assistant', usage: { output: 42 }, duration: 1_000 }
  })
  expect(native.frames.at(-1)).toMatchObject({
    method: '_orca/omp/generation',
    params: { outputTokens: 126, durationMs: 3_000 }
  })
})

it('measures missing native timing only from the actual request hook, including first-token wait', () => {
  const native = extension()
  native.emit('agent_start')
  native.at(1_000)
  native.emit('before_provider_request')
  native.at(2_000)
  native.emit('message_start', { message: { role: 'assistant' } })
  native.at(3_000)
  native.emit('message_end', { message: { role: 'assistant', usage: { output: 84 } } })
  expect(native.frames).toMatchObject([
    { method: '_orca/omp/generation', params: { outputTokens: 84, durationMs: 2_000 } }
  ])
})

it('leaves missing counters or request timing unmeasured', () => {
  const native = extension()
  native.emit('agent_start')
  native.emit('message_end', { message: { role: 'assistant', usage: { output: 84 } } })
  expect(native.frames).toEqual([])
  native.emit('agent_start')
  native.emit('before_provider_request')
  native.at(2_000)
  native.emit('message_end', { message: { role: 'assistant' } })
  expect(native.frames).toEqual([])
})
