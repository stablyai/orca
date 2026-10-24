import { expect, it } from 'vitest'
import { WSL_FAMILIES, wslOrcadQualification } from './wsl-orcad-qualification.mjs'

const runtime = 'src/main/runtime/rpc/methods/session-title.ts'
const events = Array.from({ length: 100 }, (_, index) => ({
  name: 'pull_request',
  number: 42,
  sourceSha: index.toString(16).padStart(40, '0')
}))
const event = events.find(
  (value) => wslOrcadQualification([runtime], [runtime], value).families.length === 1
)

it('canaries a minority of stable source identities while preserving full references', () => {
  expect(event).toBeDefined()
  const results = events.map((value) => wslOrcadQualification([runtime], [runtime], value))
  const smoke = results.filter((result) => result.families.length === 1)
  expect(smoke.length).toBeGreaterThan(0)
  expect(smoke.length).toBeLessThan(25)
  expect(wslOrcadQualification([runtime], [runtime], event)).toEqual(
    wslOrcadQualification([runtime], [runtime], event)
  )
  expect(results.every((result) => result.families.includes('ubuntu-24.04'))).toBe(true)
  expect(results.every((result) => result.candidateFamilies.length === 1)).toBe(true)
})

it.each([
  'src/main/wsl/wsl-orcad-deploy.ts',
  'src/main/managed-server/install/remote-install-transport.ts',
  'src/main/orcad/main.ts',
  'src/packages/process-host/src/run-process.ts',
  'src/shared/wsl-login-shell-command.ts',
  'src/main/runtime/windows-firewall.ts',
  'src/main/runtime/remote-transport.ts',
  'src/main/runtime/terminal-environment.ts',
  'src/main/wsl/wsl-orcad-real-distro-lane.test.ts',
  'native/addon.cc',
  'package.json',
  'pnpm-lock.yaml',
  'config/patches/node-pty.patch',
  'config/scripts/wsl-orcad-qualification.mjs',
  '.github/workflows/wsl-orcad-e2e.yml',
  '.github/actions/setup-pnpm/action.yml',
  'unknown.ts',
  'src/main/runtime/../outside.ts'
])('retains every distro for a mixed change containing %s', (file) => {
  expect(wslOrcadQualification([runtime, file], [runtime, file], event).families).toEqual(
    WSL_FAMILIES
  )
})

it('allows unrelated UI, documentation and unit changes alongside a runtime modification', () => {
  const companions = [
    'mobile/src/chat.tsx',
    'src/renderer/src/chat.tsx',
    'docs/ci.md',
    'src/shared/value.test.ts'
  ]
  expect(wslOrcadQualification([runtime, ...companions], [runtime], event).families).toEqual([
    'ubuntu-24.04'
  ])
})

it.each([
  { changed: [], modified: [], context: event },
  { changed: [runtime], modified: undefined, context: event },
  { changed: [runtime], modified: [], context: event },
  { changed: [runtime, runtime], modified: [runtime], context: event },
  { changed: [runtime], modified: [runtime, runtime], context: event },
  { changed: [runtime], modified: [runtime, 'missing.ts'], context: event },
  { changed: [runtime], modified: [runtime], context: {} },
  { changed: [runtime], modified: [runtime], context: { ...event, name: 'schedule' } },
  { changed: [runtime], modified: [runtime], context: { ...event, name: 'workflow_dispatch' } },
  { changed: [runtime], modified: [runtime], context: { ...event, sourceSha: '' } },
  { changed: [runtime], modified: [runtime], context: { ...event, number: 0 } }
])(
  'fails closed for incomplete, non-modification or reference evidence: %j',
  ({ changed, modified, context }) => {
    expect(wslOrcadQualification(changed, modified, context).families).toEqual(WSL_FAMILIES)
  }
)
