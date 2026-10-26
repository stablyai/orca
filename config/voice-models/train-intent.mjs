import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'

const root = process.argv[2]
if (!root) {
  throw new Error('Usage: node config/voice-models/train-intent.mjs <verified-model-directory>')
}
env.allowRemoteModels = false
env.localModelPath = `${resolve(root)}/`
const embed = await pipeline('feature-extraction', 'intent', {
  dtype: 'q8',
  device: 'cpu',
  session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 }
})
const examples = JSON.parse(await readFile(new URL('./intent-examples.json', import.meta.url)))
const weights = {}
const report = {}
const latencies = []
for (const task of ['intent', 'context']) {
  const labels = Object.keys(examples[task].train)
  const all = []
  for (const split of ['train', 'test']) {
    for (const label of labels) {
      for (const text of examples[task][split][label]) {
        if (split === 'test' && Object.values(examples[task].train).flat().includes(text)) {
          continue
        }
        const started = performance.now()
        const result = await embed(text, { pooling: 'mean', normalize: true })
        latencies.push(performance.now() - started)
        all.push({ split, text, label, x: [...result.data, 1] })
      }
    }
  }
  const train = all.filter((row) => row.split === 'train')
  const w = labels.map(() => Array(train[0].x.length).fill(0))
  const predict = (x) => {
    const logits = w.map((row) => row.reduce((sum, value, i) => sum + value * x[i], 0))
    const max = Math.max(...logits)
    const exp = logits.map((v) => Math.exp(v - max))
    const total = exp.reduce((a, b) => a + b, 0)
    return exp.map((v) => v / total)
  }
  for (let epoch = 0; epoch < 48000; epoch++) {
    const gradient = w.map((row) => row.map(() => 0))
    for (const row of train) {
      const p = predict(row.x)
      const balance = train.length / (labels.length * examples[task].train[row.label].length)
      for (let k = 0; k < labels.length; k++) {
        const error = (p[k] - Number(labels[k] === row.label)) * balance
        for (let i = 0; i < row.x.length; i++) {
          gradient[k][i] += error * row.x[i]
        }
      }
    }
    for (let k = 0; k < labels.length; k++) {
      for (let i = 0; i < w[k].length; i++) {
        w[k][i] -= 1.2 * (gradient[k][i] / train.length + 0.00001 * w[k][i])
      }
    }
  }
  weights[task] = { labels, weights: w.map((row) => row.map((v) => Number(v.toFixed(7)))) }
  const tests = all
    .filter((row) => row.split === 'test')
    .map((row) => {
      const scores = predict(row.x)
      const predicted = labels[scores.indexOf(Math.max(...scores))]
      return { text: row.text, expected: row.label, predicted, score: Math.max(...scores) }
    })
  report[task] = {
    training: train.length,
    tested: tests.length,
    correct: tests.filter((r) => r.expected === r.predicted).length,
    failures: tests.filter((r) => r.expected !== r.predicted),
    tests
  }
}
latencies.sort((a, b) => a - b)
report.inferenceMs = {
  median: latencies[Math.floor(latencies.length / 2)],
  p95: latencies[Math.floor(latencies.length * 0.95)]
}
report.note =
  'Synthetic development examples inspected during fitting; not independent accuracy or a microphone evaluation. Scores are uncalibrated.'
await writeFile(
  new URL('../../src/shared/sts-intent-weights.json', import.meta.url),
  JSON.stringify(weights)
)
await writeFile(new URL('./evaluation.json', import.meta.url), JSON.stringify(report, null, 2))
console.log(
  JSON.stringify(
    {
      ...report,
      intent: { ...report.intent, tests: undefined },
      context: { ...report.context, tests: undefined }
    },
    null,
    2
  )
)
await embed.dispose()
