import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '../../src/shared/child-process/run-process'

const action = parse(
  readFileSync('.github/actions/prepare-linux-package-fixture/action.yml', 'utf8')
)
const load = action.runs.steps.find((step) => step.id === 'image')
const workflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
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
  it('leaves a PR cache miss to the existing runner without building or exporting', () => {
    expect(exercise()).toEqual({ commands: '', output: '' })
  })

  it.each([{ loadFails: true }, { inspectFails: true }])(
    'discards an unusable restored cache: %j',
    (failure) => {
      const result = exercise({ hit: true, ...failure })
      expect(result.output).toBe('')
      expect(result.commands).toContain('load --input')
      expect(result.commands).not.toMatch(/(?:build|save) /)
    }
  )

  it('returns the local image tag after a successful load', () => {
    const result = exercise({ hit: true })
    expect(result.output).toBe('image=orca-package-fixture-cli-launch-contract:cache\n')
    expect(result.commands).not.toMatch(/(?:build|save) /)
  })

  it('loads the daemon shutdown fixture without running package or source tests in the cache action', () => {
    const result = exercise({ hit: true, fixture: 'daemon-shutdown-descendants' })
    expect(result.output).toBe('image=orca-package-fixture-daemon-shutdown-descendants:cache\n')
    expect(result.commands).not.toMatch(/(?:build|save|run) /)
  })

  it('builds and exports inline cache only when the warmer has no usable image', () => {
    const result = exercise({ save: true })
    expect(result.commands).toContain(
      'build --platform linux/amd64 --build-arg BUILDKIT_INLINE_CACHE=1'
    )
    expect(result.commands).toContain(
      '--file config/docker/cli-launch-contract/Dockerfile config/docker/cli-launch-contract'
    )
    expect(result.commands).toContain('save --output')
    expect(result.output).toBe('image=orca-package-fixture-cli-launch-contract:cache\nbuilt=true\n')
  })
})

it('uses exact context/platform keys and the same restore-only action in package checks', () => {
  const cache = action.runs.steps.find((step) => step.id === 'cache')
  expect(cache.with.key).toContain('linux-amd64')
  expect(cache.with.key).toContain("format('config/docker/{0}/**', inputs.fixture)")
  expect(cache.with.key).toContain('.github/actions/prepare-linux-package-fixture/action.yml')
  expect(cache.with['restore-keys']).toBeUndefined()
  expect(action.inputs['save-cache'].default).toBe('false')
  const prepared = workflow('pr').jobs.package.steps.filter((step) =>
    step.uses?.endsWith('/prepare-linux-package-fixture')
  )
  expect(prepared.map((step) => step.with)).toEqual([
    { fixture: 'daemon-shutdown-descendants' },
    { fixture: 'headless-serve-shutdown' },
    { fixture: 'cli-launch-contract' }
  ])
  const warm = workflow('ci-cache-warmup').jobs['warm-linux-package-fixtures']
  expect(warm.steps.slice(1).map((step) => step.with.fixture)).toEqual(
    prepared.map((step) => step.with.fixture)
  )
  expect(
    warm.steps
      .slice(1)
      .every((step) => step.with['save-cache'] === "${{ github.event_name != 'pull_request' }}")
  ).toBe(true)
})
