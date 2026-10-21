import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || typeof global.gc !== 'function') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1 node --expose-gc')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const replacements = {
  'command-code-output-status.ts': [
    'ownRetainedString(data.slice(-RECENT_TEXT_LIMIT))',
    'data.slice(-RECENT_TEXT_LIMIT)'
  ],
  'advertised-url-parsing.ts': [
    'ownRetainedString(chunk.slice(-PER_PTY_BUFFER_LIMIT))',
    'chunk.slice(-PER_PTY_BUFFER_LIMIT)'
  ],
  'advertised-url-watcher.ts': [
    'ownRetainedString(combined.slice(-PENDING_PRE_BIND_LIMIT))',
    'combined.slice(-PENDING_PRE_BIND_LIMIT)'
  ]
}
const results = []
const bundles = {}

function heapAfterGc() {
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed
}

function measure(makeOwner, validate, inputChars, count) {
  const before = heapAfterGc()
  const owners = Array.from({ length: count }, (_, index) => {
    const prefix = `${index}:`
    const suffix = `\nhttp://localhost:${4100 + index}`
    return makeOwner(
      `${prefix}${'x'.repeat(inputChars - prefix.length - suffix.length)}${suffix}`,
      index
    )
  })
  const heapDelta = heapAfterGc() - before
  owners.forEach(validate)
  return { inputChars, count, heapDelta }
}

for (const fixed of [false, true]) {
  const result = await build({
    stdin: {
      contents: `
        export { createCommandCodeOutputStatusDetector } from './src/shared/command-code-output-status'
        export { AdvertisedUrlWatcher } from './src/main/ports/advertised-url-watcher'
      `,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: fixed
      ? []
      : [
          {
            name: 'baseline-without-detector-tail-copy',
            setup(builder) {
              builder.onLoad(
                {
                  filter:
                    /(?:command-code-output-status|advertised-url-parsing|advertised-url-watcher)\.ts$/
                },
                async ({ path }) => {
                  const source = await readFile(path, 'utf8')
                  const replacement = Object.entries(replacements).find(([name]) =>
                    path.endsWith(name)
                  )?.[1]
                  if (!replacement || !source.includes(replacement[0])) {
                    throw new Error('The copy boundary changed; update the baseline transform')
                  }
                  return { contents: source.replaceAll(...replacement), loader: 'ts' }
                }
              )
            }
          }
        ]
  })
  const bundle = result.outputFiles[0].text
  bundles[fixed ? 'after' : 'before'] = createHash('sha256').update(bundle).digest('hex')
  const { createCommandCodeOutputStatusDetector, AdvertisedUrlWatcher } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
  )
  for (const [inputChars, count] of [
    [64 * 1024, 32],
    [4 * 1024 * 1024, 8]
  ]) {
    results.push({
      kind: 'command-code-detector',
      fixed,
      ...measure(
        (data) => {
          const detector = createCommandCodeOutputStatusDetector({ onWorking: () => {} })
          detector.observe(data)
          return detector
        },
        (detector) => assert.equal(detector.observe('\nordinary output\n'), false),
        inputChars,
        count
      )
    })
    for (const bound of [true, false]) {
      results.push({
        kind: bound ? 'url-bound-pty' : 'url-before-binding',
        fixed,
        ...measure(
          (data) => {
            const watcher = new AdvertisedUrlWatcher()
            if (bound) {
              watcher.bindPty('pty', 'workspace')
            }
            watcher.ingest('pty', data)
            return watcher
          },
          (watcher, index) => {
            watcher.bindPty('pty', 'workspace')
            watcher.ingest('pty', '/\n')
            assert.equal(
              watcher.lookup('workspace', 4100 + index)?.origin,
              `http://localhost:${4100 + index}`
            )
            watcher.unbindPty('pty')
            assert.equal(watcher.lookup('workspace', 4100 + index), undefined)
          },
          inputChars,
          count
        )
      })
    }
  }
}
console.log(
  JSON.stringify({ node: process.version, platform: process.platform, bundles, results }, null, 2)
)
