const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { collect, sha } = require('./queue-source.cjs')

async function postResult(keepers) {
  let ref
  await new Promise((resolve) => {
    const payload = new Uint8Array(1024 * 1024)
    payload[0] = 19
    ref = new WeakRef(payload)
    keepers.push(resolve)
    resolve({ payload })
  })
  assert(ref)
  return ref
}
async function main() {
  const keepers = []
  const refs = []
  for (let index = 0; index < 8; index++) {
    refs.push(await postResult(keepers))
  }
  await collect()
  const retainedWithResolveFunctions = refs.filter((ref) => ref.deref() !== undefined).length
  keepers.length = 0
  await collect()
  const retainedAfterResolveFunctionsReleased = refs.filter(
    (ref) => ref.deref() !== undefined
  ).length
  assert.equal(retainedAfterResolveFunctionsReleased, 0)
  const report = {
    node: process.version,
    electron: process.versions.electron ?? null,
    v8: process.versions.v8,
    proofSha256: sha(fs.readFileSync(__filename)),
    payloads: 8,
    bytesPerPayload: 1024 * 1024,
    retainedWithResolveFunctions,
    retainedAfterResolveFunctionsReleased
  }
  const resultName = process.versions.electron
    ? 'electron-resolver-results.json'
    : 'resolver-results.json'
  fs.writeFileSync(path.join(__dirname, resultName), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('fixture timeout')
  process.exit(2)
}, 10000).unref()
