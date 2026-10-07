const fs = require('node:fs')
const fsp = require('node:fs/promises')
const cp = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const esbuild = require(path.join(process.cwd(), 'node_modules/esbuild'))
const before = '09dbe227547fadaec8d9163f35fd127b0dc1c3ed'
const prefix = 'src/main/crash-reporting/'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-crash-stream-parity-'))
const source = fs.readFileSync(`${prefix}minidump-crash-signature.test.ts`, 'utf8')
const fixture = `const expect = (v) => ({toBe: (e) => {if(v!==e) throw new Error('fixture invariant')}});\n${source.slice(
  source.indexOf('const STREAM_TYPE_'),
  source.indexOf("describe('parseMinidumpCrashSignature'")
)}`
const line = '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !x.'
async function build() {
  for (const variant of ['before', 'after']) {
    await esbuild.build({
      entryPoints: [`${prefix}minidump-crash-signature.ts`],
      outfile: path.join(dir, `${variant}.cjs`),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins:
        variant === 'before'
          ? [
              {
                name: 'baseline',
                setup(b) {
                  b.onLoad(
                    {
                      filter: /minidump-(crash-signature|stream-reader|crashpad-annotations)\.ts$/
                    },
                    (a) => ({
                      contents: cp.execFileSync(
                        'git',
                        ['show', `${before}:${path.relative(process.cwd(), a.path)}`],
                        { encoding: 'utf8' }
                      ),
                      loader: 'ts'
                    })
                  )
                }
              }
            ]
          : []
    })
  }
  await esbuild.build({
    stdin: { contents: `${fixture}\nexport {buildDump}`, loader: 'ts', resolveDir: process.cwd() },
    outfile: path.join(dir, 'fixture.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  await esbuild.build({
    entryPoints: [`${prefix}minidump-file-source.ts`],
    outfile: path.join(dir, 'file.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
}
;(async () => {
  try {
    await build()
    const baseline = require(path.join(dir, 'before.cjs')).parseMinidumpCrashSignature
    const candidate = require(path.join(dir, 'after.cjs')).parseMinidumpCrashSignature
    const create = require(path.join(dir, 'file.cjs')).createMinidumpFileSource
    const { buildDump } = require(path.join(dir, 'fixture.cjs'))
    let checked = 0
    const inputs = []
    for (const annotations of [
      {},
      { ptype: 'renderer' },
      { ptype: 'gpu-process', LOG_FATAL: line },
      { ptype: 'renderer', 'abort-message': line }
    ]) {
      for (const moduleCount of [0, 1, 8, 128]) {
        const { dump } = buildDump({
          annotations,
          modules: Array.from({ length: moduleCount }, (_, i) => ({
            base: BigInt(0x1000 + i * 0x1000),
            size: 0x1000,
            name: `x${i}.dll`
          })),
          exception: { code: 0x80000003, address: 0x1001n }
        })
        inputs.push(dump)
      }
    }
    const header = buildDump({ annotations: { ptype: 'renderer' } }).dump
    for (const shift of [-100, -40, -1, 0, 1, 40, 100]) {
      for (const severity of ['FATAL', 'CHECK', 'DFATAL', 'ERROR']) {
        const text = line.replace('FATAL', severity) + 'x'.repeat(4000 - line.length)
        const bytes = Buffer.alloc(1024 * 1024 + shift + text.length + 2)
        header.copy(bytes)
        bytes.write(text, 1024 * 1024 + shift)
        inputs.push(bytes)
      }
    }
    for (const n of [255, 256, 257]) {
      inputs.push(Buffer.concat([header, Buffer.from(`${':FATAL:bad\0'.repeat(n) + line}\0`)]))
    }
    for (const bytes of inputs) {
      const expected = baseline(bytes)
      assert.deepEqual(await candidate(bytes), expected)
      const p = path.join(dir, 'sample.dmp')
      await fsp.writeFile(p, bytes)
      const h = await fsp.open(p, 'r')
      try {
        assert.deepEqual(await candidate(create(h, bytes.length)), expected)
      } finally {
        await h.close()
      }
      checked++
    }
    const timing = []
    for (const size of [8, 64]) {
      const p = path.join(dir, 'large.dmp')
      await fsp.writeFile(p, header)
      await fsp.truncate(p, size * 1024 * 1024)
      const samples = { before: [], after: [] }
      for (let i = 0; i < 6; i++) {
        for (const mode of ['before', 'after']) {
          const t = performance.now()
          if (mode === 'before') {
            baseline(await fsp.readFile(p))
          } else {
            const h = await fsp.open(p, 'r')
            try {
              await candidate(create(h, size * 1024 * 1024))
            } finally {
              await h.close()
            }
          }
          if (i > 0) {
            samples[mode].push(performance.now() - t)
          }
        }
      }
      timing.push({ sizeMiB: size, ...samples })
    }
    console.log(JSON.stringify({ before, parityCases: checked, timing }, null, 2))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
