import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}

const sourcePath = 'src/main/ai-vault/session-scanner-service-entry.ts'
const source = readFileSync(new URL(`../../../${sourcePath}`, import.meta.url), 'utf8')
const guard = '    if (!pending.has(raw.id)) {\n      return\n    }\n'
const requestCount = 1000
assert.equal(source.split(guard).length, 2, 'Review changed baseline transform')

async function run(version) {
  const original = version === 'before' ? source.replace(guard, '') : source
  const { code } = await transform(original, { loader: 'ts', format: 'esm', target: 'es2022' })
  const entry = code.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
  assert.equal(/^import\b/m.test(entry), false, 'Unexpected production import shape')
  const processStub = new EventEmitter()
  let responses = 0
  processStub.send = (message) => {
    if (message.type === 'result') {
      responses++
    }
  }
  processStub.pid = 1
  const context = {
    process: processStub,
    performance,
    AbortController,
    requestSessionSearchRoots: () => undefined,
    SessionScannerServiceSearch: class {
      handles() {
        return false
      }
    },
    AI_VAULT_SERVICE_PROTOCOL_VERSION: 1,
    aiVaultServiceLane: () => 'interactive',
    isAiVaultServiceRequest: (raw) => raw.type === 'request',
    readAiVaultFirstUserPrompt: async () => ({ prompt: null }),
    inspect: undefined
  }
  runInNewContext(
    `${entry}\ninspect = () => ({ pending: pending.size, controllers: controllers.size, cancelled: cancelled.size })`,
    context,
    { timeout: 1000, filename: fileURLToPath(new URL(`../../../${sourcePath}`, import.meta.url)) }
  )
  try {
    processStub.emit('message', { type: 'init', protocol: 1 })
    for (let id = 1; id <= requestCount; id++) {
      processStub.emit('message', {
        type: 'request',
        id,
        operation: 'firstPrompt',
        request: { agent: 'claude', filePath: '/synthetic' }
      })
      await new Promise(setImmediate)
      processStub.emit('message', { type: 'cancel', id })
    }
    const retained = context.inspect()
    assert.equal(responses, requestCount)
    assert.equal(retained.pending, 0)
    assert.equal(retained.controllers, 0)
    assert.equal(retained.cancelled, version === 'before' ? requestCount : 0)
    return {
      source: version === 'before' ? 'working tree without pending guard' : 'working tree',
      sourceSha256: createHash('sha256').update(original).digest('hex'),
      requests: requestCount,
      responses,
      ...retained
    }
  } finally {
    processStub.removeAllListeners()
  }
}

const results = {
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  heapLimitBytes: getHeapStatistics().heap_size_limit,
  sourcePath,
  baselineTransform: 'Remove only the three-line pending-membership guard in memory',
  harness: 'Production entry in isolated VM contexts; imported collaborators stubbed',
  before: await run('before'),
  after: await run('after')
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
