import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STS_TURN_MODEL_FILES } from '../../src/shared/sts-turn-models.ts'

const directory = process.argv[2]
if (!directory) {
  throw new Error('Usage: node config/voice-models/download.mjs <model-directory>')
}
const paths = {
  'intent-config.json': 'intent/config.json',
  'intent-tokenizer.json': 'intent/tokenizer.json',
  'intent-tokenizer_config.json': 'intent/tokenizer_config.json',
  'intent-model.onnx': 'intent/onnx/model_quantized.onnx',
  'endpoint.onnx': 'endpoint/smart-turn-v3.2-cpu.onnx'
}
for (const file of STS_TURN_MODEL_FILES) {
  const target = join(directory, paths[file.name])
  const valid = (bytes) =>
    bytes.length === file.sizeBytes &&
    createHash('sha256').update(bytes).digest('hex') === file.sha256
  let cached
  try {
    cached = await readFile(target)
  } catch {}
  if (cached && valid(cached)) {
    continue
  }
  const response = await fetch(file.url, { signal: AbortSignal.timeout(600000) })
  if (!response.ok) {
    throw new Error(`Model download failed: ${file.name} HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!valid(bytes)) {
    throw new Error(`Model integrity check failed: ${file.name}`)
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
}
console.log('Verified all pinned local voice model assets')
