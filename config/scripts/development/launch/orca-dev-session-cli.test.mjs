import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../../../..')
const launcherFile = 'config/scripts/development/launch/orca-dev.mjs'

// The launcher picks the CLI that a command reaches, so a wrong pick can write to the real app.
describe.skipIf(process.platform === 'win32')("orca-dev and a session's own CLI", () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-dev-handoff-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [
    launcherFile,
    'config/scripts/development/launch/dev-cli-terminal-wrapper.mjs',
    'config/scripts/development/instance-isolation/dev-instance-isolation.mjs'
  ]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    copyFileSync(path.join(projectDir, file), path.join(root, file))
  }
  const launcher = path.join(root, launcherFile)
  chmodSync(launcher, 0o755)
  mkdirSync(path.join(root, 'out', 'cli'), { recursive: true })
  writeFileSync(
    path.join(root, 'out', 'cli', 'index.js'),
    'process.stdout.write(`dev ${process.argv.slice(2).join(" ")} profile=${process.env.ORCA_USER_DATA_PATH}`)'
  )
  const recordedProfile = path.join(root, 'recorded-profile')
  mkdirSync(recordedProfile)
  writeFileSync(
    path.join(root, 'out', 'dev-instance.json'),
    JSON.stringify({ userData: recordedProfile, profile: 'shared' })
  )
  const pathBin = path.join(root, 'path-bin')
  mkdirSync(pathBin)
  for (const name of ['orca', 'orca-dev']) {
    symlinkSync(launcher, path.join(pathBin, name))
  }
  const sessionCli = (name) => {
    const cli = path.join(root, 'session', name)
    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, '#!/bin/sh\nprintf "session %s" "$*"\n')
    chmodSync(cli, 0o755)
    return cli
  }
  const releaseCli = sessionCli('orca')

  const run = (command, env) => {
    const result = spawnSync(command[0], [...command.slice(1), 'repo', 'add', 'x'], {
      env: {
        PATH: `${pathBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
        ORCA_APP_EXECUTABLE: path.join(root, 'Electron'),
        ...env
      },
      encoding: 'utf8'
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }

  it('keeps explicit dev runs on the dev build inside a release session', () => {
    const profile = path.join(root, 'throwaway-profile')
    const cases = [
      [[process.execPath, launcher], { ORCA_DEV_USER_DATA_PATH: profile }, profile],
      [[process.execPath, launcher], {}, recordedProfile],
      [['orca-dev'], {}, recordedProfile],
      [['orca'], { ORCA_DEV_USER_DATA_PATH: profile }, profile]
    ]
    for (const [command, env, expectedProfile] of cases) {
      expect(run(command, { ORCA_CLI_COMMAND: releaseCli, ...env }).stdout).toBe(
        `dev repo add x profile=${expectedProfile}`
      )
    }
  })

  it("hands off when PATH reached it under the session CLI's name, and says so", () => {
    expect(run(['orca'], { ORCA_CLI_COMMAND: releaseCli })).toEqual({
      stdout: 'session repo add x',
      stderr: `orca: running this session's CLI, ${releaseCli}\n`
    })
    const devSessionCli = sessionCli('orca-dev')
    expect(run(['orca-dev'], { ORCA_CLI_COMMAND: devSessionCli }).stdout).toBe('session repo add x')
  })
})
