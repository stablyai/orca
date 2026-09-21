import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || typeof global.gc !== 'function') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1 node --expose-gc')
}
const script = import.meta.filename
const root = fileURLToPath(new URL('../../../', import.meta.url))

if (process.argv[2] === 'child') {
  const { consumeCompleteJsonlLines, getReadBytes } = await import(pathToFileURL(process.argv[3]))
  global.gc()
  const before = process.memoryUsage()
  let result = null
  let error = null
  let decodedBytes = 0
  try {
    result = await consumeCompleteJsonlLines({
      path: process.argv[4],
      start: 0,
      onLine: (line) => {
        decodedBytes += Buffer.byteLength(line)
      }
    })
  } catch (caught) {
    error = String(caught)
  }
  const afterRead = process.memoryUsage()
  global.gc()
  global.gc()
  const retained = process.memoryUsage()
  console.log(
    JSON.stringify({
      error,
      bytesRead: getReadBytes(),
      decodedBytes,
      trailingChars: result?.trailingPartialLine?.length ?? 0,
      consumedThrough: result?.consumedThrough ?? null,
      heapDeltaAfterGc: retained.heapUsed - before.heapUsed,
      externalDeltaAfterRead: afterRead.external - before.external,
      maxRssKiB: process.resourceUsage().maxRSS
    })
  )
} else {
  const temp = await mkdtemp(join(import.meta.dirname, '.run-'))
  try {
    const file = join(temp, 'record.jsonl')
    const handle = await open(file, 'w')
    const chunk = Buffer.alloc(1024 * 1024, 'x')
    try {
      for (let index = 0; index < 64; index++) {
        await handle.write(chunk)
      }
    } finally {
      await handle.close()
    }
    const bundles = {}
    for (const fixed of [false, true]) {
      const built = await build({
        stdin: {
          contents: `export { consumeCompleteJsonlLines } from './src/main/ai-vault/session-scanner-jsonl-reader'; export { getReadBytes } from 'evidence-native-stream'`,
          resolveDir: root,
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        plugins: [
          {
            name: 'native-reader-evidence',
            setup(builder) {
              builder.onResolve(
                { filter: /(?:wsl-transcript-fs-access|evidence-native-stream)$/ },
                () => ({ path: 'reader', namespace: 'evidence' })
              )
              builder.onLoad({ filter: /.*/, namespace: 'evidence' }, () => ({
                contents: `import { createReadStream } from 'node:fs';
                let bytes = 0;
                export const getReadBytes = () => bytes;
                export async function* openTranscriptReadStream(path, options) {
                  for await (const chunk of createReadStream(path, options)) {
                    bytes += chunk.length;
                    yield chunk;
                  }
                }`,
                loader: 'js'
              }))
              if (!fixed) {
                builder.onLoad(
                  { filter: /session-scanner-jsonl-reader\.ts$/ },
                  async ({ path }) => {
                    const source = await readFile(path, 'utf8')
                    const pattern = /^\s+assertSessionTranscriptRecordBytes\([^\n]+\)\n/gm
                    if ([...source.matchAll(pattern)].length !== 3) {
                      throw new Error('Update baseline transform')
                    }
                    return { contents: source.replace(pattern, '\n'), loader: 'ts' }
                  }
                )
              }
            }
          }
        ]
      })
      const source = built.outputFiles[0].text
      bundles[fixed ? 'after' : 'before'] = createHash('sha256').update(source).digest('hex')
      await writeFile(join(temp, `${fixed}.mjs`), source)
    }
    const results = []
    for (const terminated of [false, true]) {
      if (terminated) {
        await appendFile(file, '\n')
      }
      for (const fixed of [false, true]) {
        const child = spawnSync(
          process.execPath,
          [
            '--expose-gc',
            '--max-old-space-size=384',
            script,
            'child',
            join(temp, `${fixed}.mjs`),
            file
          ],
          { encoding: 'utf8', timeout: 30000 }
        )
        if (child.status !== 0) {
          throw new Error(child.stderr || String(child.error))
        }
        results.push({ terminated, fixed, ...JSON.parse(child.stdout) })
      }
    }
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          recordBytes: 64 * 1024 * 1024,
          bundles,
          results
        },
        null,
        2
      )
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
