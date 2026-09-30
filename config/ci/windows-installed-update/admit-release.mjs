// Admits a public release installer by pinned sha256 and a valid Authenticode signature.
// Usage: node admit-release.mjs --installer <exe> --sha256 <hex> --tag <tag> --commit <sha>
//   --protocol-source <daemon-protocol-version.ts> --output <dir>
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runProcessSync } from '../../scripts/script-child-process.mjs'
import { parseDaemonProtocolFacts } from './daemon-protocol-facts.mjs'
import { hashFile } from './installed-layout.mjs'
import {
  authenticodeScript,
  parseAuthenticode,
  windowsPowerShellSpec
} from './windows-evidence.mjs'

const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index].replace(/^--/u, ''), process.argv[index + 1])
}
const required = (name) => {
  const value = options.get(name)
  assert.ok(value, `--${name} is required`)
  return value
}
const installer = resolve(required('installer'))
const tag = required('tag')
const version = /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1]
assert.ok(version, 'only stable release tags are admitted')
assert.equal(await hashFile(installer), required('sha256'), 'release installer digest mismatch')
const query = runProcessSync(windowsPowerShellSpec(authenticodeScript(installer)))
assert.equal(query.code, 0, `Authenticode query failed: ${query.stderr.trim()}`)
const signer = parseAuthenticode(query.stdout)
assert.equal(signer.status, 'Valid', 'release installer signature is not valid')
assert.match(signer.thumbprint, /^[A-F0-9]{40}$/u)

const output = resolve(required('output'))
mkdirSync(output, { recursive: true })
copyFileSync(installer, join(output, 'orca-windows-setup.exe'))
const receipt = {
  label: 'release',
  tag,
  commit: required('commit'),
  version,
  sha256: required('sha256'),
  signer,
  daemonProtocol: parseDaemonProtocolFacts(readFileSync(required('protocol-source'), 'utf8'))
}
writeFileSync(join(output, 'release-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(
  JSON.stringify({
    tag,
    version,
    signer: signer.subject,
    protocol: receipt.daemonProtocol.protocolVersion
  })
)
