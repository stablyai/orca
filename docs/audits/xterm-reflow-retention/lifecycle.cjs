const assert = require('node:assert/strict')
const fs = require('node:fs')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const install = require('./install-candidate.cjs')
function fixture(Terminal) {
  const terminal = new Terminal({
    cols: 80,
    rows: 8,
    scrollback: 120,
    allowProposedApi: true,
    logLevel: 'off'
  })
  terminal._core.writeSync(`${'x'.repeat(80 * 127)}\r\n`)
  terminal.resize(8, 8)
  const array = terminal._core._bufferService.buffer.lines._array
  assert.equal(Object.keys(array).filter((key) => Number(key) < 0).length, 127)
  return { terminal, refs: { array: new WeakRef(array), row: new WeakRef(array[-1]) } }
}
async function main() {
  const cases = []
  for (const packageName of ['@xterm/headless', '@xterm/xterm']) {
    const source = install(packageName, false)
    const { Terminal } = require(packageName)
    for (const action of ['clear', 'reset', 'dispose-retained-terminal', 'dispose-drop-terminal']) {
      const value = fixture(Terminal)
      if (action === 'clear') {
        value.terminal.clear()
      }
      if (action === 'reset') {
        value.terminal.reset()
      }
      if (action.startsWith('dispose')) {
        value.terminal.dispose()
      }
      if (action === 'dispose-drop-terminal') {
        value.terminal = null
      }
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setImmediate(resolve))
        global.gc()
      }
      const retainedArray = !!value.refs.array.deref()
      const retainedRow = !!value.refs.row.deref()
      const expected = action === 'clear' || action === 'dispose-retained-terminal'
      assert.equal(retainedArray, expected, `${packageName} ${action}: old array`)
      assert.equal(retainedRow, expected, `${packageName} ${action}: old negative row`)
      cases.push({ packageName, action, retainedArray, retainedRow, source })
      value.terminal?.dispose()
      value.terminal = null
    }
  }
  fs.writeFileSync(
    `${__dirname}/lifecycle-results.json`,
    `${JSON.stringify({ node: process.version, cases }, null, 2)}\n`
  )
  console.log(
    JSON.stringify(
      cases.map(({ packageName, action, retainedArray, retainedRow }) => ({
        packageName,
        action,
        retainedArray,
        retainedRow
      }))
    )
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
