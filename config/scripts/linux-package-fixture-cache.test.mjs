import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'

const action = parse(
  readFileSync('.github/actions/prepare-linux-package-fixture/action.yml', 'utf8')
)
const load = action.runs.steps.find((step) => step.id === 'image')
let directory

afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function exercise({
  hit = false,
  save = false,
  loadFails = false,
  inspectFails = false,
  fixture = 'cli-launch-contract'
} = {}) {
  directory = mkdtempSync(join(tmpdir(), 'orca-package-cache-'))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const commandLog = join(directory, 'commands')
  const output = join(directory, 'output')
  writeFileSync(commandLog, '')
  writeFileSync(output, '')
  const docker = join(bin, 'docker')
  writeFileSync(
    docker,
    '#!/bin/bash\n' +
      'echo "$*" >> "$COMMAND_LOG"\n' +
      'if [[ "$1" == load && "$LOAD_FAILS" == true ]]; then exit 1; fi\n' +
      'if [[ "$1 $2" == "image inspect" ]]; then\n' +
      '  if [[ "$INSPECT_FAILS" == true ]]; then exit 1; fi\n' +
      '  echo sha256:fixture-image\n' +
      'fi\n'
  )
  chmodSync(docker, 0o755)
  const result = runProcessSync({
    program: 'bash',
    args: ['-c', load.run],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      GITHUB_ACTION_PATH: join(process.cwd(), '.github/actions/prepare-linux-package-fixture'),
      RUNNER_TEMP: directory,
      GITHUB_OUTPUT: output,
      COMMAND_LOG: commandLog,
      FIXTURE: fixture,
      CACHE_HIT: String(hit),
      SAVE_CACHE: String(save),
      LOAD_FAILS: String(loadFails),
      INSPECT_FAILS: String(inspectFails)
    },
    timeoutMs: 10_000
  })
  expect(result.code, result.stderr).toBe(0)
  return { commands: readFileSync(commandLog, 'utf8'), output: readFileSync(output, 'utf8') }
}

describe.runIf(process.platform !== 'win32')('fixture cache fallbacks', () => {
  it.each([{ loadFails: true }, { inspectFails: true }])(
    'discards an unusable restored cache: %j',
    (failure) => {
      const result = exercise({ hit: true, ...failure })
      expect(result.output).toBe('')
      expect(result.commands).toContain('load --input')
      expect(result.commands).not.toMatch(/(?:build|save) /)
    }
  )
})
