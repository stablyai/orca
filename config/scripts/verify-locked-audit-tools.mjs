import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { auditToolEntry, installAuditTools } from './run-audit-tool.mjs'

const root = resolve(import.meta.dirname, '../..')
const installed = installAuditTools(root)
assert.equal(installed.code, 0, 'Frozen, script-free audit tool install failed')

const scratch = join(root, 'tmp')
mkdirSync(scratch, { recursive: true })
const fixture = mkdtempSync(join(scratch, 'locked audit tools '))
const toolManifest = JSON.parse(readFileSync(join(root, 'config/audit-tools/package.json'), 'utf8'))

function command(program, args, expectedCode = 0) {
  const result = runProcessSync({ program, args, cwd: fixture, timeoutMs: 60_000 })
  assert.equal(result.timedOut, false, `${program} timed out`)
  assert.equal(result.signal, null, `${program} received ${result.signal}`)
  assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`)
  return result.stdout
}

function tool(name, args, expectedCode = 0) {
  return command(process.execPath, [auditToolEntry(name, root), ...args], expectedCode)
}

function write(file, value) {
  writeFileSync(join(fixture, file), value)
}

const cleanComponent = 'export default function App() { return <button>Ready</button> }\n'
const indexKeyComponent =
  'export default function App() { return <div>{["one"].map((text, index) => <span key={index}>{text}</span>)}</div> }\n'
const doctorArgs = [
  '.',
  '--yes',
  '--no-dead-code',
  '--no-supply-chain',
  '--no-telemetry',
  '--no-cache',
  '--json',
  '--blocking',
  'warning'
]

try {
  command('git', ['init', '--quiet'])
  command('git', ['config', 'core.hooksPath', join(fixture, '.git', 'disabled-hooks')])
  command('git', ['config', 'commit.gpgSign', 'false'])
  write(
    'package.json',
    JSON.stringify({ name: 'locked-audit-smoke', private: true, dependencies: { react: '19.2.8' } })
  )
  write('App.tsx', cleanComponent)
  write('knip.json', JSON.stringify({ entry: ['App.tsx'], project: ['*.tsx'] }))

  for (const name of ['react-doctor', 'knip']) {
    assert.equal(tool(name, ['--version']).trim(), toolManifest.dependencies[name])
  }

  const clean = JSON.parse(tool('react-doctor', doctorArgs))
  assert.equal(clean.ok, true)
  assert.ok(clean.projects.some((project) => project.analyzedFiles.includes('App.tsx')))
  tool('knip', ['--config', 'knip.json', '--files'])

  write('App.tsx', indexKeyComponent)
  command('git', ['add', '.'])
  command('git', [
    '-c',
    'user.name=Audit tool smoke',
    '-c',
    'user.email=audit-smoke@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Baseline'
  ])
  write('Changed.tsx', indexKeyComponent.replace('function App', 'function Changed'))
  command('git', ['add', 'Changed.tsx'])
  const changed = JSON.parse(
    tool('react-doctor', [...doctorArgs, '--scope', 'lines', '--base', 'HEAD'], 1)
  )
  assert.ok(changed.diagnostics.some((item) => item.filePath.endsWith('Changed.tsx')))
  assert.ok(changed.diagnostics.every((item) => !item.filePath.endsWith('App.tsx')))

  write('Orphan.tsx', 'export const orphan = true\n')
  assert.match(tool('knip', ['--config', 'knip.json', '--files'], 1), /Orphan\.tsx/)

  const stale = join(fixture, 'config', 'audit-tools')
  mkdirSync(stale, { recursive: true })
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    copyFileSync(join(root, 'config', 'audit-tools', file), join(stale, file))
  }
  writeFileSync(
    join(stale, 'package.json'),
    JSON.stringify({
      ...toolManifest,
      dependencies: { ...toolManifest.dependencies, knip: '0.0.0' }
    })
  )
  const rejected = installAuditTools(fixture, (spec) => runProcessSync({ ...spec, stdio: 'pipe' }))
  assert.notEqual(rejected.code, 0, 'A stale tool lockfile was accepted')
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /OUTDATED_LOCKFILE/)
  console.log(
    'Locked audit tools: real analysis, changed-line filtering, findings and stale-lock rejection passed'
  )
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
