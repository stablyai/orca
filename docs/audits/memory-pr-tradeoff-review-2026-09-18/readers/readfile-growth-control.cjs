const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const binding = process.binding('fs')
async function measure(root, initialBytes, appendedBytes, encoding) {
  const file = path.join(root, `case-${initialBytes}-${encoding || 'buffer'}`)
  await fs.writeFile(file, Buffer.alloc(initialBytes, 0x61))
  const handle = await fs.open(file, 'r')
  const original = binding.fstat
  let observedSize
  let hookCalls = 0
  binding.fstat = function (...args) {
    const result = original.apply(this, args)
    if (args[0] !== handle.fd || !result?.then || hookCalls > 0) return result
    hookCalls++
    return result.then(async (stats) => {
      observedSize = stats[8]
      await fs.appendFile(file, Buffer.alloc(appendedBytes, 0x62))
      return stats
    })
  }
  let value
  try {
    value = await handle.readFile(encoding)
  } finally {
    binding.fstat = original
    await handle.close()
  }
  assert.equal(hookCalls, 1)
  assert.equal(observedSize, initialBytes)
  return {
    initialBytes,
    appendedBytes,
    encoding: encoding || 'buffer',
    observedSize,
    returnedBytes: Buffer.byteLength(value),
    hookCalls
  }
}
async function main() {
  const root = await fs.mkdtemp(path.join(__dirname, 'growth-control-'))
  try {
    const cases = []
    for (const [size, encoding] of [
      [131, undefined],
      [1024 * 1024 + 131, undefined],
      [131, 'utf8'],
      [1024 * 1024 + 131, 'utf8'],
      [0, undefined]
    ]) {
      cases.push(await measure(root, size, 1024 * 1024, encoding))
    }
    assert.equal(cases[0].returnedBytes, 131)
    assert.equal(cases[1].returnedBytes, 1024 * 1024 + 131)
    assert.equal(cases[2].returnedBytes, 131)
    assert.equal(cases[3].returnedBytes, 2 * 1024 * 1024 + 131)
    assert.equal(cases[4].returnedBytes, 1024 * 1024)
    process.stdout.write(
      JSON.stringify(
        {
          versions: process.versions,
          cases,
          meaning:
            'Native readFile fstat intercepted once to append before the first read; Buffer and large encoded reads differ. Test-only internal binding interception.'
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
