import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const run = promisify(execFile)
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it.skipIf(process.platform === 'win32').each([
  ['13.5', 'node', true],
  ['13.4', 'electron', true],
  ['27.2', 'node', true],
  ['unknown', 'electron', true],
  ['13.5', 'electron', false]
] as const)(
  'runs the packaged CLI on %s with %s (helper executable: %s)',
  async (version, runtime, executable) => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-mac-cli-')))
    const contents = join(root, 'Test.app', 'Contents')
    const bin = join(contents, 'Resources', 'bin')
    const helper = join(contents, 'Helpers', 'Orca Agents.app', 'Contents')
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(join(contents, 'MacOS'), { recursive: true }),
      mkdir(join(helper, 'MacOS'), { recursive: true })
    ])
    const systemVersion = join(root, 'SystemVersion.plist')
    await writeFile(
      systemVersion,
      `<plist><dict>\n<key>ProductVersion</key>\n<string>${version}</string>\n</dict></plist>\n`
    )
    await writeFile(
      join(helper, 'Info.plist'),
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
      [join(helper, 'MacOS', 'Orca Agents'), 'node']
    ]) {
      await writeFile(
        path,
        `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" "NODE_OPTIONS:\${NODE_OPTIONS-unset}" "ORCA_NODE_OPTIONS:\${ORCA_NODE_OPTIONS-unset}"\n`
      )
      await chmod(path, name === 'node' && !executable ? 0o644 : 0o755)
    }
    const result = await run('/bin/bash', [launcher, 'status', '--json'], {
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
      'status',
      '--json',
      'NODE_OPTIONS:unset',
      'ORCA_NODE_OPTIONS:--max-old-space-size=2048',
      ''
    ])
  }
)
