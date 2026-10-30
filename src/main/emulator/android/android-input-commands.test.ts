import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { androidTypeText } from './android-input-commands'
import type { AndroidCommandRunner } from './android-command-runner'

describe.runIf(process.platform !== 'win32')('Android text shell boundary', () => {
  it.each([
    'plain',
    'hello world',
    "it's fine",
    'hello&world',
    'say "hello"',
    '$ORCA_ANDROID_TEXT_VALUE',
    '$(printf changed)',
    'semi;printf changed',
    '`printf changed`',
    '*',
    'back\\slash',
    ''
  ])('delivers literal text %j as one input argument', async (text) => {
    let output = ''
    const runner: AndroidCommandRunner = async (_binary, args) => {
      const result = spawnSync(
        '/bin/sh',
        ['-c', `input() { printf '%s\\n' "$#" "$@"; }; ${args.slice(3).join(' ')}`],
        {
          encoding: 'utf8',
          env: { ...process.env, ORCA_ANDROID_TEXT_VALUE: 'expanded' }
        }
      )
      if (result.error) {
        throw result.error
      }
      output = result.stdout
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
    }
    await androidTypeText(
      runner,
      { sdkRoot: 'sdk', adb: 'adb', emulator: 'emulator', avdmanager: 'avdmanager' },
      'emulator-5558',
      text
    )
    expect(output).toBe(`2\ntext\n${text.replace(/ /g, '%s')}\n`)
  })
})
