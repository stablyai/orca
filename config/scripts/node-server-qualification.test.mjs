import { expect, it } from 'vitest'
import { NODE_SERVER_RUNNERS, nodeServerQualification } from './node-server-qualification.mjs'

const scope = { shouldRun: true }

it('qualifies one platform for a change no platform can alter', () => {
  expect(nodeServerQualification(['src/main/runtime/rpc/methods/example.ts'], scope)).toEqual({
    qualification: false,
    runners: ['ubuntu-22.04']
  })
})

it.each([
  'src/renderer/src/components/TabStrip.tsx',
  'config/vitest.config.ts',
  'config/scripts/ci-unit-plan.mjs',
  'resources/icons/tray.png',
  '.github/workflows/pr.yml',
  'docs/reference/agent-status-store.md'
])('keeps one platform for unflavoured input %s', (file) => {
  expect(nodeServerQualification([file], scope).runners).toEqual(['ubuntu-22.04'])
})

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'native/windows-registry/src/addon.cc',
  'config/patches/node-pty.patch',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/actions/prepare-native-runtime/action.yml',
  '.github/actions/prepare-orcad-prebuilds/action.yml',
  'src/main/ssh/ssh-provider.ts',
  'src/main/providers/local-pty-provider.ts',
  'src/shared/child-process/run-process.ts',
  'src/main/persistence/profile-state/store.ts',
  'src/main/sqlite/database.ts',
  'src/main/orcad/entry.ts',
  'src/main/daemon/entry.ts',
  'src/relay/index.ts',
  'config/scripts/build-orcad-prebuilds.mjs',
  'config/scripts/orcad-prebuild-slot-contents.mjs',
  'src/shared/node-runtime-pin.ts'
])('retains all platforms for platform-flavoured input %s', (file) => {
  expect(nodeServerQualification([file], scope)).toEqual({
    qualification: true,
    runners: NODE_SERVER_RUNNERS
  })
})

it('fails closed to every platform when the evidence is incomplete', () => {
  expect(nodeServerQualification([], scope).qualification).toBe(true)
  expect(
    nodeServerQualification(['src/main/runtime/rpc/methods/example.ts'], {
      ...scope,
      graphUnavailable: true
    }).qualification
  ).toBe(true)
})

it.each([
  [
    'src/main/runtime/windows-terminal.ts',
    ['ubuntu-22.04', 'windows-2022', 'windows-11-arm'],
    false
  ],
  [
    'src/main/windows/windows-process-table.ts',
    ['ubuntu-22.04', 'windows-2022', 'windows-11-arm'],
    false
  ],
  ['src/main/wsl/runner.ts', ['ubuntu-22.04', 'windows-2022', 'windows-11-arm'], false],
  [
    'src/main/orcad/orcad-launcher.win32.test.ts',
    ['ubuntu-22.04', 'windows-2022', 'windows-11-arm'],
    false
  ],
  ['src/main/daemon/darwin-process.ts', ['ubuntu-22.04', 'macos-14', 'macos-15-intel'], false],
  ['src/shared/linux-glibc.ts', ['ubuntu-22.04', 'ubuntu-24.04-arm'], true],
  [
    'src/main/daemon/posix-process.ts',
    ['ubuntu-22.04', 'ubuntu-24.04-arm', 'macos-14', 'macos-15-intel'],
    true
  ]
])('selects both architectures and a Linux smoke for %s', (file, runners, qualification) => {
  expect(nodeServerQualification([file], scope)).toEqual({ runners, qualification })
})

it('combines platform families without adding Linux compatibility work', () => {
  expect(
    nodeServerQualification(
      ['src/main/windows/windows-process-table.ts', 'src/main/daemon/darwin-process.ts'],
      scope
    )
  ).toEqual({
    runners: ['ubuntu-22.04', 'macos-14', 'macos-15-intel', 'windows-2022', 'windows-11-arm'],
    qualification: false
  })
})

it('keeps all hosts for shared changes alongside a platform-specific change', () => {
  expect(
    nodeServerQualification(
      ['src/main/windows/windows-process-table.ts', 'src/main/daemon/entry.ts'],
      scope
    )
  ).toEqual({ runners: NODE_SERVER_RUNNERS, qualification: true })
})

it.each([
  'src/main/ssh/remote-node-runtime-store-windows.ts',
  'src/main/ssh/orcad-remote-node-runtime-windows.ts',
  'src/main/ssh/ssh-posix-command-wrapper.test.ts',
  'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
  'src/relay/windows-port-scan.ts',
  'src/main/runtime/windows-firewall-remote-scope.ts',
  'src/shared/remote-windows-path.ts'
])('qualifies every client platform for a remote execution input: %s', (file) => {
  expect(nodeServerQualification([file], scope)).toEqual({
    runners: NODE_SERVER_RUNNERS,
    qualification: true
  })
})

it.each([
  '.github/workflows/node-server-tests.yml',
  'config/scripts/node-server-qualification.mjs'
])('qualifies all hosts when the selection policy changes: %s', (file) => {
  expect(nodeServerQualification([file], scope)).toEqual({
    runners: NODE_SERVER_RUNNERS,
    qualification: true
  })
})

it('fully qualifies relevant main pushes even for an unflavoured change', () => {
  expect(
    nodeServerQualification(['src/main/runtime/rpc/methods/example.ts'], scope, {
      fullQualification: true
    })
  ).toEqual({ runners: NODE_SERVER_RUNNERS, qualification: true })
})
