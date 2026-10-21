import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const sourcePaths = [
  'src/main/native-chat/agent-session-journal/journal-legacy-import.ts',
  'src/main/native-chat/transcript-stream-lines.ts'
]
const limit = 16 * 1024 * 1024
const grownBytes = 17 * 1024 * 1024

function sourceAt(version, path) {
  const source = fs.readFileSync(resolve(root, path), 'utf8')
  if (version !== 'before' || path !== sourcePaths[0]) {
    return source
  }
  const stream = 'const stream = createReadStream(input.filePath)'
  const budget = 'true,\n    MAX_LEGACY_IMPORT_SOURCE_BYTES'
  assert.ok(source.includes(stream) && source.includes(budget), 'Review changed baseline transform')
  return source
    .replace(stream, "const stream = createReadStream(input.filePath, { encoding: 'utf-8' })")
    .replace(budget, 'true')
}

async function run(version) {
  const sources = new Map(sourcePaths.map((path) => [path, sourceAt(version, path)]))
  const built = await build({
    absWorkingDir: root,
    entryPoints: [sourcePaths[0]],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    plugins: [
      {
        name: 'select-production-version',
        setup(bundler) {
          bundler.onLoad(
            { filter: /(?:journal-legacy-import|transcript-stream-lines)\.ts$/ },
            (args) => {
              const path = relative(root, args.path).split('\\').join('/')
              const contents = sources.get(path)
              return contents === undefined ? undefined : { contents, loader: 'ts' }
            }
          )
          bundler.onResolve({ filter: /session-file-resolver$/ }, () => ({
            path: 'unused',
            namespace: 'probe'
          }))
          bundler.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
            contents:
              'export function resolveSessionFilePath() { throw new Error("Unexpected path discovery") }'
          }))
        }
      }
    ]
  })
  const directory = await fsPromises.mkdtemp(join(tmpdir(), 'orca-legacy-source-budget-'))
  const filePath = join(directory, 'growing.jsonl')
  const initial = `${JSON.stringify({
    type: 'assistant',
    uuid: 'valid-prefix',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Existing journal must survive refusal' }]
    }
  })}\n`
  let consumedBytes = 0
  let observedStatBytes
  let stream
  let replaceCalls = 0
  let journalEpoch = 'prior-epoch'
  const compiled = new Module(join(root, 'legacy-import-budget-probe.cjs'))
  compiled.filename = join(root, 'legacy-import-budget-probe.cjs')
  compiled.paths = Module._nodeModulePaths(root)
  compiled.require = (id) => {
    if (id === 'node:fs/promises') {
      return {
        ...fsPromises,
        stat: async (...args) => {
          const snapshot = await fsPromises.stat(...args)
          if (args[0] === filePath) {
            observedStatBytes = snapshot.size
            await fsPromises.appendFile(filePath, Buffer.alloc(grownBytes - snapshot.size, 0x20))
          }
          return snapshot
        }
      }
    }
    if (id === 'node:fs') {
      return {
        ...fs,
        createReadStream: (...args) => {
          stream = fs.createReadStream(...args)
          stream.on('data', (chunk) => {
            consumedBytes += Buffer.isBuffer(chunk)
              ? chunk.byteLength
              : Buffer.byteLength(chunk, 'utf8')
          })
          return stream
        }
      }
    }
    return require(id)
  }
  compiled._compile(built.outputFiles[0].text, compiled.filename)
  try {
    await fsPromises.writeFile(filePath, initial)
    const result = await compiled.exports.importLegacyTranscriptIntoJournal({
      agent: 'claude',
      sessionId: 'source-budget-probe',
      fence: 0,
      options: { filePath },
      journal: {
        cursor: () => ({ epoch: journalEpoch, sequence: 0 }),
        replaceEpochItems: async () => {
          replaceCalls++
          journalEpoch = 'replacement-epoch'
          return { epoch: journalEpoch, sequence: 1 }
        }
      }
    })
    assert.equal(observedStatBytes, Buffer.byteLength(initial))
    assert.equal(stream.destroyed, true)
    assert.equal(result.ok, version === 'before')
    assert.equal(replaceCalls, version === 'before' ? 1 : 0)
    return {
      source: version === 'before' ? 'working tree without consumed-byte quota' : 'working tree',
      sourceSha256: Object.fromEntries(
        [...sources].map(([path, source]) => [
          path,
          createHash('sha256').update(source).digest('hex')
        ])
      ),
      observedStatBytes,
      sourceBytesAfterGrowth: (await fsPromises.stat(filePath)).size,
      consumedBytes,
      limitBytes: limit,
      streamDestroyed: stream.destroyed,
      result,
      journalReplaceCalls: replaceCalls,
      journalEpoch
    }
  } finally {
    stream?.destroy()
    await fsPromises.rm(directory, { recursive: true, force: true })
  }
}

const results = {
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  before: await run('before'),
  after: await run('after')
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
