import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { evaluateSecurityAudit } from './dependency-security-audit.mjs'
import { readSecurityAudit } from './check-dependency-security.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const today = '2026-10-22'
const patch = 'reviewed security fix\n'
const sha256 = createHash('sha256').update(patch).digest('hex')
const exception = {
  workspace: '.',
  package: 'example',
  version: '1.2.3',
  advisory: 'GHSA-1234-5678-9abc',
  owner: 'Maintainer',
  reason: 'Patched while awaiting upstream',
  expires: '2026-11-20',
  patch: { path: 'example.patch', sha256 }
}
function audit(severity = 'high', versions = ['1.2.3']) {
  return {
    advisories: versions.length
      ? {
          123: {
            module_name: 'example',
            github_advisory_id: exception.advisory,
            severity,
            url: 'https://github.com/advisories/GHSA-1234-5678-9abc',
            findings: versions.map((version) => ({ version, paths: ['.>build-tool>example'] }))
          }
        }
      : {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        [severity]: versions.length ? 1 : 0
      }
    }
  }
}
function patchedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'orca-dependency-security-'))
  roots.push(root)
  writeFileSync(join(root, 'example.patch'), patch)
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    stringify({
      patchedDependencies: { 'example@1.2.3': 'example.patch' }
    })
  )
  const lock = {
    patchedDependencies: { 'example@1.2.3': sha256 },
    snapshots: { [`example@1.2.3(patch_hash=${sha256})`]: {} }
  }
  const writeLock = () =>
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      `---\n${stringify({ lockfileVersion: '9.0', importers: {}, snapshots: {} })}---\n${stringify(lock)}`
    )
  writeLock()
  return { root, lock, writeLock }
}

it.each(['high', 'critical'])('blocks %s advisories including build-time findings', (severity) => {
  expect(evaluateSecurityAudit(audit(severity), '.', [], { today })).toEqual([
    expect.objectContaining({ severity, blocking: true })
  ])
})
it('retains lower severities without blocking', () => {
  expect(evaluateSecurityAudit(audit('moderate'), '.', [], { today })).toEqual([
    expect.objectContaining({ severity: 'moderate', blocking: false })
  ])
})
it('applies an exception only to the exact patched finding', () => {
  const { root } = patchedWorkspace()
  const findings = evaluateSecurityAudit(audit('high', ['1.2.3', '2.0.0']), '.', [exception], {
    root,
    today
  })
  expect(findings.map((item) => item.blocking)).toEqual([false, true])
  for (const change of [
    { workspace: 'mobile' },
    { package: 'other' },
    { advisory: 'GHSA-abcd-5678-9abc' }
  ]) {
    expect(
      evaluateSecurityAudit(audit(), '.', [{ ...exception, ...change }], { root, today })[0]
        .blocking
    ).toBe(true)
  }
})
it('lets expired and removed patch exceptions coexist with a clean graph', () => {
  expect(
    evaluateSecurityAudit(audit('high', []), '.', [exception], { today: '2026-11-20' })
  ).toEqual([])
  expect(
    evaluateSecurityAudit(audit(), '.', [exception], { today: '2026-11-20' })[0].blocking
  ).toBe(true)
})
it.each(['bytes', 'registration', 'lock hash', 'unpatched snapshot'])(
  'refuses a changed %s',
  (change) => {
    const { root, lock, writeLock } = patchedWorkspace()
    if (change === 'bytes') {
      writeFileSync(join(root, 'example.patch'), 'different fix')
    }
    if (change === 'registration') {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), '{}')
    }
    if (change === 'lock hash') {
      lock.patchedDependencies['example@1.2.3'] = '0'.repeat(64)
    }
    if (change === 'unpatched snapshot') {
      lock.snapshots['example@1.2.3'] = {}
    }
    writeLock()
    expect(() => evaluateSecurityAudit(audit(), '.', [exception], { root, today })).toThrow(
      'Reviewed patch'
    )
  }
)
it('rejects incomplete reports instead of treating them as clean', () => {
  expect(() => evaluateSecurityAudit({}, '.', [], { today })).toThrow()
  const incomplete = audit()
  incomplete.advisories = {}
  expect(() => evaluateSecurityAudit(incomplete, '.', [], { today })).toThrow('Incomplete')
})
it.each([
  { code: 2 },
  { signal: 'SIGTERM' },
  { timedOut: true },
  { outputTruncated: true },
  { stdout: '{' },
  { code: 1, stdout: '{"error":"registry unavailable"}' }
])('fails closed on scanner errors: %j', (change) => {
  expect(() => readSecurityAudit({ code: 0, stdout: JSON.stringify(audit()), ...change })).toThrow()
})
it('reads nonzero finding reports for policy evaluation', () => {
  expect(readSecurityAudit({ code: 1, stdout: JSON.stringify(audit()) })).toEqual(audit())
})
