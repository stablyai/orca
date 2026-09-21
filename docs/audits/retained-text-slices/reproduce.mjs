import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || typeof global.gc !== 'function') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1 node --expose-gc')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const replacements = {
  'recent-pty-output-buffer.ts': [
    'this.chunks = [data.length > this.limit ? ownRetainedString(data.slice(-this.limit)) : data]',
    'this.chunks = [data.slice(-this.limit)]'
  ],
  'check-job-log-tail-slice.ts': [
    'return ownRetainedString(buildCheckLogTail(logText))',
    'return buildCheckLogTail(logText)'
  ],
  'workspace-session-terminal-buffers.ts': [
    'return ownRetainedString(\n    clampUtf8TextTail(buffer, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT).text\n  )',
    'return clampUtf8TextTail(buffer, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT).text'
  ],
  'pty-eager-buffer-clamp.ts': [
    'data: tail.text.length < data.length ? flattenRetainedSlice(tail.text) : tail.text',
    'data: tail.text'
  ],
  'terminal-error-accumulation.ts': ['return flattenRetainedSlice(bounded)', 'return bounded'],
  'deferred-reattach-live-data-queue.ts': [
    'flattenRetainedSlice(chunk.data.slice(-MAX_DEFERRED_REATTACH_LIVE_CHARS))',
    'chunk.data.slice(-MAX_DEFERRED_REATTACH_LIVE_CHARS)'
  ]
}
const results = []
const bundles = {}
const parentChars = 2 * 1024 * 1024
const count = 8

function measure(excerpt, makeLog) {
  global.gc()
  const before = process.memoryUsage().heapUsed
  const retained = Array.from({ length: count }, (_, index) => excerpt(makeLog(index)))
  // Clear V8's independent legacy RegExp input reference before measuring our retained values.
  void /probe/.test('probe')
  global.gc()
  global.gc()
  const heapDelta = process.memoryUsage().heapUsed - before
  return {
    entries: retained.length,
    logicalChars: retained.reduce((total, text) => total + text.length, 0),
    logicalBytes: retained.reduce((total, text) => total + Buffer.byteLength(text), 0),
    heapDelta
  }
}

for (const fixed of [false, true]) {
  const result = await build({
    stdin: {
      contents: `
        export { RecentPtyOutputBuffer } from './src/main/runtime/recent-pty-output-buffer'
        export { sliceCheckLogTail } from './src/shared/check-job-log-tail-slice'
        export { gitLabJobTraceToLogExcerpt } from './src/shared/gitlab-job-log-excerpt'
        export { capTerminalScrollbackSessionBuffer } from './src/shared/workspace-session-terminal-buffers'
        export { clampUtf8Tail } from './src/renderer/src/components/terminal-pane/pty-eager-buffer-clamp'
        export { boundTerminalErrorSurface } from './src/renderer/src/components/terminal-pane/terminal-error-accumulation'
        export { DeferredReattachLiveDataQueue } from './src/renderer/src/components/terminal-pane/deferred-reattach-live-data-queue'
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
            name: 'baseline-without-retained-tail-copy',
            setup(builder) {
              builder.onLoad(
                {
                  filter:
                    /(?:recent-pty-output-buffer|check-job-log-tail-slice|workspace-session-terminal-buffers|pty-eager-buffer-clamp|terminal-error-accumulation|deferred-reattach-live-data-queue)\.ts$/
                },
                async ({ path }) => {
                  const source = await readFile(path, 'utf8')
                  const replacement = Object.entries(replacements).find(([name]) =>
                    path.endsWith(name)
                  )?.[1]
                  if (!replacement || !source.includes(replacement[0])) {
                    throw new Error('The copy boundary changed; update the baseline transform')
                  }
                  return {
                    contents: source.replaceAll(...replacement),
                    loader: 'ts'
                  }
                }
              )
            }
          }
        ]
  })
  const bundle = result.outputFiles[0].text
  bundles[fixed ? 'after' : 'before'] = createHash('sha256').update(bundle).digest('hex')
  const {
    sliceCheckLogTail,
    gitLabJobTraceToLogExcerpt,
    capTerminalScrollbackSessionBuffer,
    clampUtf8Tail,
    boundTerminalErrorSurface,
    DeferredReattachLiveDataQueue,
    RecentPtyOutputBuffer
  } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`)
  for (const [kind, makeLog, excerpt] of [
    ['github-long-line', (i) => `${i}:${'x'.repeat(parentChars)}`, sliceCheckLogTail],
    [
      'github-earlier-error',
      (i) => `error: ${i}:${'界'.repeat(parentChars)}\n${'recent\n'.repeat(100)}`,
      sliceCheckLogTail
    ],
    ['gitlab-long-line', (i) => `${i}:${'x'.repeat(parentChars)}`, gitLabJobTraceToLogExcerpt],
    [
      'terminal-session-buffer',
      (i) => `${i}:${'x'.repeat(parentChars * 2)}`,
      capTerminalScrollbackSessionBuffer
    ],
    [
      'terminal-eager-buffer',
      (i) => `${i}:${'x'.repeat(parentChars * 2)}`,
      (text) => clampUtf8Tail(text, 512 * 1024).data
    ],
    [
      'terminal-recent-output',
      (i) => `${i}:${'x'.repeat(parentChars * 2)}`,
      (data) => {
        const buffer = new RecentPtyOutputBuffer()
        buffer.append(data)
        return buffer.read()
      }
    ],
    ['terminal-error', (i) => `${'x'.repeat(parentChars * 2)}:${i}`, boundTerminalErrorSurface],
    [
      'terminal-deferred-reattach',
      (i) => `${i}:${'x'.repeat(parentChars * 2)}`,
      (data) => {
        const queue = new DeferredReattachLiveDataQueue()
        queue.enqueue({ data, ptyId: 'p', streamGeneration: 1 })
        return queue.takeAll()[0].data
      }
    ]
  ]) {
    results.push({ kind, fixed, ...measure(excerpt, makeLog) })
  }
}
console.log(
  JSON.stringify(
    { node: process.version, platform: process.platform, parentChars, count, bundles, results },
    null,
    2
  )
)
