import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { chromium } from 'playwright-core'
import { STS_STOP_CONFIDENCE } from '../../src/shared/sts-turn-models.ts'

const modelDirectory = process.argv[2]
if (!modelDirectory) {
  throw new Error('Usage: node config/voice-models/smoke.mjs <verified-model-directory>')
}
const root = resolve('out/renderer/assets')
const names = await readdir(root)
const worker = names.find((name) => /^sts-local-model\.worker-.*\.js$/.test(name))
if (!worker) {
  throw new Error('Build the renderer first')
}
const modelNames = {
  'intent-config.json': 'intent/config.json',
  'intent-tokenizer.json': 'intent/tokenizer.json',
  'intent-tokenizer_config.json': 'intent/tokenizer_config.json',
  'intent-model.onnx': 'intent/onnx/model_quantized.onnx',
  'endpoint.onnx': 'endpoint/smart-turn-v3.2-cpu.onnx'
}
const multilingualCases = [
  ['yes', 'backchannel'],
  ['stop speaking', 'stop'],
  ['Explain this function', 'speech'],
  ['对', 'backchannel'],
  ['停止说话', 'stop'],
  ['能解释这个函数吗？', 'speech'],
  ['そうですね', 'backchannel'],
  ['話すのをやめて', 'stop'],
  ['この関数を説明してもらえますか？', 'speech'],
  ['entiendo', 'backchannel'],
  ['deja de hablar', 'stop'],
  ['¿Puedes explicar esta función?', 'speech'],
  ['je vois', 'backchannel'],
  ['arrête de parler', 'stop'],
  ['Peux-tu expliquer cette fonction ?', 'speech'],
  ['entendi', 'backchannel'],
  ['pare de falar', 'stop'],
  ['Você pode explicar esta função?', 'speech']
]
const server = createServer(async (request, response) => {
  try {
    const name = basename(new URL(request.url, 'http://localhost').pathname)
    if (name === 'index.html') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<title>Local turn model verification</title>')
      return
    }
    const model = modelNames[name]
    if (!model && !names.includes(name)) {
      response.writeHead(404).end()
      return
    }
    response.setHeader(
      'Content-Type',
      name.endsWith('.wasm')
        ? 'application/wasm'
        : name.endsWith('.js') || name.endsWith('.mjs')
          ? 'text/javascript'
          : 'application/octet-stream'
    )
    response.end(await readFile(model ? join(modelDirectory, model) : join(root, name)))
  } catch {
    response.writeHead(500).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const external = []
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') {
      return route.continue()
    }
    external.push(route.request().url())
    return route.abort()
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`)
  const result = await page.evaluate(
    async ({ worker, files, multilingualCases }) => {
      const assets = await Promise.all(
        files.map(async (name) => ({
          name,
          bytes: new Uint8Array(await (await fetch(`/models/${name}`)).arrayBuffer())
        }))
      )
      const model = new Worker(`/assets/${worker}`, { type: 'module' })
      let id = 0
      const request = (message) =>
        new Promise((resolve, reject) => {
          const requestId = ++id
          const timer = setTimeout(() => reject(new Error('Model verification timeout')), 30000)
          model.onmessage = (event) => {
            if (event.data.id !== requestId) {
              return
            }
            clearTimeout(timer)
            if (event.data.error) {
              reject(new Error(event.data.error))
            } else {
              resolve(event.data)
            }
          }
          model.onerror = (event) => {
            clearTimeout(timer)
            reject(new Error(event.message))
          }
          model.postMessage({ ...message, id: requestId })
        })
      const started = performance.now()
      try {
        await request({ type: 'init', assets })
        const startupMs = performance.now() - started
        const rows = []
        for (const [text, output] of [
          ['응', '두 가지 방법을 비교할게요.'],
          ['네', '진행해도 괜찮을지 알려주세요.'],
          ['네?', '두 가지 방법을 비교할게요.'],
          ['아니 그 파일부터 수정해줘', ''],
          ['잠깐', ''],
          ['멈추지 마', ''],
          ...multilingualCases.map(([text]) => [text, ''])
        ]) {
          const start = performance.now()
          const prediction = await request({ type: 'predict', text, output })
          rows.push({ text, ...prediction.result, ms: performance.now() - start })
        }
        const audio = Float32Array.from({ length: 16000 }, (_, i) =>
          i < 12800 ? 0.1 * Math.sin((i * 2 * Math.PI * 220) / 16000) : 0
        )
        const start = performance.now()
        const endpoint = await request({
          type: 'predict',
          text: '음성 경로 확인',
          output: '',
          audio
        })
        return {
          startupMs,
          rows,
          endpoint: endpoint.result.complete,
          endpointMs: performance.now() - start
        }
      } finally {
        model.terminate()
      }
    },
    { worker, files: Object.keys(modelNames), multilingualCases }
  )
  console.log(JSON.stringify({ ...result, externalRequests: external.length, errors }, null, 2))
  assert.equal(external.length, 0, 'Inference must not use external services')
  assert.equal(result.rows[0].intent, 'backchannel')
  assert.equal(result.rows[1].expectsAnswer, true)
  assert.equal(result.rows[2].intent, 'speech')
  assert.equal(result.rows[3].intent, 'speech')
  assert.equal(result.rows[4].intent, 'stop')
  assert.ok(
    result.rows[4].confidence >= STS_STOP_CONFIDENCE,
    `A plain stop must interrupt promptly: ${JSON.stringify(result.rows[4])}`
  )
  assert.ok(
    result.rows[5].intent !== 'stop' || result.rows[5].confidence < STS_STOP_CONFIDENCE,
    'Negated stop must not be consumed'
  )
  assert.ok(Number.isFinite(result.endpoint) && result.endpoint >= 0 && result.endpoint <= 1)
  for (const [index, [text, intent]] of multilingualCases.entries()) {
    assert.equal(result.rows[index + 6].intent, intent, text)
    if (intent === 'stop') {
      assert.ok(
        result.rows[index + 6].confidence >= STS_STOP_CONFIDENCE,
        JSON.stringify(result.rows[index + 6])
      )
    }
  }
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
