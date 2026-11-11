import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { createGatedCallCollector } from '../../process-boundaries/gated-call-use-collector.mjs'
import { countSqliteCalls } from '../../process-boundaries/sqlite-call-use-collector.mjs'
import { isMainBlockingSource } from '../../process-boundaries/main-blocking-source-paths.mjs'
import { propertyName } from '../../module-requests/static-module-specifiers.mjs'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'

export const OFF_MAIN_ADVICE =
  'Move CPU or SQL work to a worker, utility process or the backend; async is right only for real I/O waits. Use asynchronous requests and replies for IPC.'
const advice = (names) => Object.fromEntries(names.map((name) => [name, OFF_MAIN_ADVICE]))
const collectors = new Map([
  [
    'compression',
    createGatedCallCollector(
      [
        {
          modules: ['node:zlib', 'zlib'],
          exportPattern: /Sync$/,
          defaultAdvice: OFF_MAIN_ADVICE,
          advice: advice([
            'gzipSync',
            'gunzipSync',
            'deflateSync',
            'inflateSync',
            'deflateRawSync',
            'inflateRawSync',
            'unzipSync',
            'brotliCompressSync',
            'brotliDecompressSync',
            'zstdCompressSync',
            'zstdDecompressSync'
          ])
        }
      ],
      'main compression'
    )
  ],
  [
    'crypto',
    createGatedCallCollector(
      [{ modules: ['node:crypto', 'crypto'], advice: advice(['pbkdf2Sync', 'scryptSync']) }],
      'main crypto'
    )
  ],
  [
    'atomics',
    createGatedCallCollector(
      [{ modules: [], globals: ['Atomics'], advice: advice(['wait']) }],
      'main Atomics'
    )
  ]
])

export function countBlockingApis(sources) {
  const counts = new Map(
    ['compression', 'crypto', 'atomics', 'sqlite', 'ipc'].map((name) => [name, new Map()])
  )
  for (const [file, contents] of sources) {
    if (!isMainBlockingSource(file)) {
      continue
    }
    for (const [category, collector] of collectors) {
      const { count } = collector.collectUses(file, contents)
      if (count) {
        counts.get(category).set(file, count)
      }
    }
    const sql = countSqliteCalls(file, contents)
    if (sql) {
      counts.get('sqlite').set(file, sql)
    }
    const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
    let ipc = 0
    function visit(node) {
      if (
        file.startsWith('src/preload/') &&
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
        propertyName(node.expression) === 'sendSync'
      ) {
        ipc++
      }
      if (
        file.startsWith('src/main/') &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        propertyName(node.left) === 'returnValue'
      ) {
        ipc++
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (ipc) {
      counts.get('ipc').set(file, ipc)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  const counts = countBlockingApis(
    readTrackedSources(root, ['src/main', 'src/shared', 'src/preload'], isMainBlockingSource)
  )
  let status = 0
  for (const [category, current] of counts) {
    const result = runCountRatchet(
      {
        name: `main-blocking-${category}`,
        baselinePath: `config/main-blocking-${category}-baseline.txt`,
        header: [
          `# Legacy synchronous ${category} uses per file; counts may only go DOWN.`,
          '# Only explicit worker/utility entry files are exempt; their imports remain guarded.'
        ],
        collect: () => current,
        pruneCommand:
          'node config/scripts/static-analysis/ratchets/runtime-lifecycle/check-main-blocking-api-ratchet.mjs --prune',
        unit: `blocking ${category} use(s)`,
        fix: [OFF_MAIN_ADVICE]
      },
      root,
      arg
    )
    status ||= result
  }
  return status
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.cwd(), process.argv[2])
}
