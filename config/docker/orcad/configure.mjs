import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { sourceFingerprint } from './source-metadata.mjs'

const root = resolve(import.meta.dirname, '../../..')
const index = process.argv.indexOf('--output')
const output =
  index === -1 ? resolve(import.meta.dirname, '.env') : resolve(process.argv[index + 1])
const revision = await runProcess({ program: 'git', args: ['rev-parse', 'HEAD'], cwd: root })
if (revision.code !== 0 || !/^[0-9a-f]{40}\s*$/.test(revision.stdout)) {
  throw new Error('Run from a source checkout with a full Git revision')
}
const status = await runProcess({
  program: 'git',
  args: ['status', '--porcelain', '--untracked-files=normal'],
  cwd: root
})
if (status.code !== 0) {
  throw new Error('Cannot determine whether the source checkout has changes')
}
const fingerprint = await sourceFingerprint(root)
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const dirty = status.stdout.trim().length > 0
const image = `orca/orcad:${pkg.version}-${revision.stdout.trim().slice(0, 12)}-${fingerprint.slice(0, 12)}`
await writeFile(
  output,
  [
    `ORCAD_SOURCE_COMMIT=${revision.stdout.trim()}`,
    `ORCAD_SOURCE_DIRTY=${dirty}`,
    `ORCAD_SOURCE_FINGERPRINT=${fingerprint}`,
    `ORCAD_IMAGE=${image}`,
    'ORCAD_PUBLISH_ADDRESS=127.0.0.1',
    'ORCAD_PUBLISH_PORT=6768',
    'ORCAD_PAIRING_ADDRESS=127.0.0.1:6768',
    'ORCAD_CLAUDE_CODE_VERSION=2.1.310',
    'ORCAD_CODEX_VERSION=',
    'ORCAD_GEMINI_CLI_VERSION=',
    ''
  ].join('\n'),
  { flag: process.argv.includes('--force') ? 'w' : 'wx', mode: 0o600 }
)
console.log(`Wrote ${output}\nLocal image: ${image}\nSource changes: ${dirty}`)
