const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const esbuild = require('esbuild')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const root = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(__dirname, '.run-'))
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex')
async function main() {
  for (const [source, output] of [
    ['src/main/daemon/headless-emulator.ts', 'emulator.cjs'],
    ['src/shared/child-process/run-process.ts', 'launcher.cjs']
  ]) {
    esbuild.buildSync({
      entryPoints: [path.join(root, source)],
      platform: 'node',
      bundle: true,
      packages: 'external',
      format: 'cjs',
      outfile: path.join(scratch, output)
    })
  }
  const { runProcess } = require(path.join(scratch, 'launcher.cjs'))
  async function run(script, args, gc) {
    const result = await runProcess({
      program: process.execPath,
      args: [
        ...(gc ? ['--expose-gc'] : []),
        '--max-old-space-size=192',
        path.join(__dirname, script),
        ...args
      ],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_REFLOW_BUNDLE_DIR: scratch },
      timeoutMs: 15000,
      maxOutputBytes: 65536
    })
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0, result.stderr)
    return result
  }
  const cases = [
    { oldCols: 80, newCols: 80, capacity: 1000 },
    { oldCols: 80, newCols: 2, capacity: 1000, fillCols: 2 },
    { oldCols: 80, newCols: 2, capacity: 1000 },
    { oldCols: 80, newCols: 8, capacity: 1000 },
    { oldCols: 80, newCols: 8, capacity: 5000 },
    { oldCols: 200, newCols: 8, capacity: 5000 },
    { oldCols: 200, newCols: 20, capacity: 5000 },
    { oldCols: 80, newCols: 8, capacity: 1000, wrapped: true },
    { oldCols: 80, newCols: 8, capacity: 1000, wrapped: true, candidate: true }
  ]
  const reports = []
  for (const input of cases) {
    const result = await run('child.cjs', [JSON.stringify(input)], true)
    const report = JSON.parse(result.stdout)
    reports.push({ ...report, exitCode: result.code, timedOut: result.timedOut })
    console.log(
      JSON.stringify({
        input,
        createdRows: report.createdRows,
        negativeSlots: report.observations.at(-1).negativeSlotCount,
        wrappedParity: report.wrappedParity
      })
    )
  }
  const before = reports.at(-2)
  const after = reports.at(-1)
  assert.equal(before.observations.at(-1).negativeSlotCount, 999)
  assert.equal(before.wrappedParity.mismatches.length, 1)
  assert.equal(after.observations.at(-1).negativeSlotCount, 0)
  assert.equal(after.wrappedParity.mismatches.length, 0)
  assert.equal(after.createdRows, before.createdRows)
  const parity = await run('parity.cjs', [], false)
  console.log(parity.stdout)
  const lifecycle = await run('lifecycle.cjs', [], true)
  console.log(lifecycle.stdout)
  const sourcePaths = [
    'src/main/daemon/headless-emulator.ts',
    'src/shared/child-process/run-process.ts',
    'node_modules/@xterm/headless/lib-headless/xterm-headless.js',
    'node_modules/@xterm/headless/lib-headless/xterm-headless.js.map',
    'node_modules/@xterm/xterm/lib/xterm.js',
    'node_modules/@xterm/xterm/src/common/buffer/Buffer.ts',
    'node_modules/@xterm/xterm/src/common/CircularList.ts',
    ...['child.cjs', 'install-candidate.cjs', 'parity.cjs', 'lifecycle.cjs', 'reproduce.cjs'].map(
      (file) => `docs/audits/xterm-reflow-retention/${file}`
    )
  ]
  const sources = Object.fromEntries(
    sourcePaths.map((file) => [file, sha(fs.readFileSync(path.join(root, file)))])
  )
  fs.writeFileSync(
    path.join(__dirname, 'results.json'),
    `${JSON.stringify({ node: process.version, sources, reports, parity: { exitCode: parity.code, timedOut: parity.timedOut, cases: 28 }, lifecycle: { exitCode: lifecycle.code, timedOut: lifecycle.timedOut, cases: 8 } }, null, 2)}\n`
  )
}
main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => fs.rmSync(scratch, { recursive: true, force: true }))
