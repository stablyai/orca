import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const run = promisify(execFile)
const {
  macTerminalHostPaths
}: {
  macTerminalHostPaths: (appPath: string) => { infoPlist: string; executable: string }
} = createRequire(import.meta.url)(
  '../../../../config/scripts/macos/terminal-host-bundle/macos-terminal-host-bundle.cjs'
)
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it.skipIf(process.platform === 'win32').each([
  ['13.5', 'node', true, ['status', '--json']],
  ['13.4', 'electron', true, ['status', '--json']],
  ['27.2', 'node', true, ['status', '--json']],
  ['unknown', 'electron', true, ['status', '--json']],
  ['13.5', 'electron', false, ['status', '--json']],
  ['13.5', 'electron', true, ['open', '--json']],
  ['13.5', 'electron', true, ['serve', '--port', '1']],
  ['13.5', 'electron', true, ['profile', 'state', 'rollback']],
  ['13.5', 'electron', true, ['--json', 'status']],
  ['13.5', 'electron', true, ['--environment', 'local', 'open']],
  ['13.5', 'node', true, ['--help']],
  ['13.5', 'node', true, ['--version']],
  ['13.5', 'node', true, []]
] as const)(
  'runs the packaged CLI on %s with %s (helper executable: %s, args: %j)',
  async (version, runtime, executable, args) => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-mac-cli-')))
    const contents = join(root, 'Test.app', 'Contents')
    const bin = join(contents, 'Resources', 'bin')
    const helper = macTerminalHostPaths(join(root, 'Test.app'))
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(contents, 'MacOS'), { recursive: true }),
      mkdir(dirname(helper.executable), { recursive: true })
    ])
    const systemVersion = join(root, 'SystemVersion.plist')
    await writeFile(
      systemVersion,
      `<plist><dict>\n<key>ProductVersion</key>\n<string>${version}</string>\n</dict></plist>\n`
    )
    await writeFile(
      helper.infoPlist,
      '<plist><dict>\n<key>LSMinimumSystemVersion</key>\n<string>13.5</string>\n</dict></plist>\n'
    )
    const shim = await readFile(join(__dirname, '../../../../resources/darwin/bin/orca'), 'utf8')
    const launcher = join(bin, 'orca')
    await writeFile(
      launcher,
      shim.replace('/System/Library/CoreServices/SystemVersion.plist', systemVersion)
    )
    for (const [path, name] of [
      [join(contents, 'MacOS', 'Orca'), 'electron'],
      [helper.executable, 'node']
    ]) {
      await writeFile(
        path,
        `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" "NODE_OPTIONS:\${NODE_OPTIONS-unset}" "ORCA_NODE_OPTIONS:\${ORCA_NODE_OPTIONS-unset}" "ELECTRON:\${ORCA_CLI_ELECTRON_EXECUTABLE-unset}"\n`
      )
      await chmod(path, name === 'node' && !executable ? 0o644 : 0o755)
    }
    const result = await run('/bin/bash', [launcher, ...args], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        NODE_OPTIONS: '--max-old-space-size=2048',
        ORCA_BACKGROUND_LAUNCH: '1'
      }
    })
    expect(result.stdout.split('\n')).toEqual([
      runtime,
      join(contents, 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js'),
      ...args,
      'NODE_OPTIONS:unset',
      'ORCA_NODE_OPTIONS:--max-old-space-size=2048',
      `ELECTRON:${runtime === 'node' ? join(contents, 'MacOS', 'Orca') : 'unset'}`,
      ''
    ])
  }
)
