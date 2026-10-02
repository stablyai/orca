import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const action = parse(readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8'))
const installScript = action.runs.steps.find((step) => step.name === 'Install dependencies').run
const storeScript = action.runs.steps.find((step) => step.id === 'pnpm-store').run

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-install-node-action-'))
  const workspace = join(root, 'checkout')
  const detachedCwd = join(root, 'action cwd')
  const bin = join(root, 'bin')
  mkdirSync(workspace)
  mkdirSync(detachedCwd)
  mkdirSync(bin)

  for (const directory of [workspace, detachedCwd]) {
    writeFileSync(join(directory, 'package.json'), '{"name":"fixture"}\n')
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n')
  }

  expect(run('git', ['init', '-q'], { cwd: workspace }).status).toBe(0)
  expect(
    run('git', ['add', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'], {
      cwd: workspace
    }).status
  ).toBe(0)

  const pnpm = join(bin, 'pnpm')
  writeFileSync(
    pnpm,
    '#!/bin/sh\nif [ "$1" = store ]; then printf "%s\\n" "$PNPM_TEST_STORE_PATH"; fi\nexit 0\n'
  )
  chmodSync(pnpm, 0o755)
  return { bin, detachedCwd, root, workspace }
}

function executeInstallScript(fixture) {
  return run('bash', ['-c', installScript], {
    cwd: fixture.detachedCwd,
    env: {
      ...process.env,
      GITHUB_WORKSPACE: fixture.workspace,
      PATH: `${fixture.bin}${delimiter}${process.env.PATH}`
    }
  })
}

describe('install-node-dependencies action', () => {
  it.each(['/home/runner/pnpm store/v11', 'C:\\Users\\runner\\pnpm store\\v11'])(
    'preserves setup-node store path %s and lowercase architecture',
    (storePath) => {
      const fixture = createFixture()
      const output = join(fixture.root, 'github-output')
      try {
        const result = run('bash', ['-e', '-o', 'pipefail', '-c', storeScript], {
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            LOCKFILE_HASH: 'lockfile-digest',
            PNPM_TEST_STORE_PATH: storePath,
            PATH: `${fixture.bin}${delimiter}${process.env.PATH}`
          }
        })
        expect(result.status, result.stderr || result.stdout).toBe(0)
        expect(readFileSync(output, 'utf8')).toBe(`path=${storePath}\narch=${process.arch}\n`)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    ['', 'store'],
    ['lockfile-digest', '']
  ])('rejects a missing lockfile hash or store path (%s, %s)', (hash, storePath) => {
    const fixture = createFixture()
    try {
      const result = run('bash', ['-e', '-o', 'pipefail', '-c', storeScript], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: join(fixture.root, 'github-output'),
          LOCKFILE_HASH: hash,
          PNPM_TEST_STORE_PATH: storePath,
          PATH: `${fixture.bin}${delimiter}${process.env.PATH}`
        }
      })
      expect(result.status).toBe(1)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('skips the lockfile diff when a job container has no Git metadata', () => {
    const fixture = createFixture()
    try {
      rmSync(join(fixture.workspace, '.git'), { recursive: true, force: true })

      const result = executeInstallScript(fixture)
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/^diff --git /m)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('skips the lockfile diff for a bare repository', () => {
    const fixture = createFixture()
    try {
      rmSync(join(fixture.workspace, '.git'), { recursive: true, force: true })
      expect(run('git', ['init', '--bare', '-q'], { cwd: fixture.workspace }).status).toBe(0)

      const result = executeInstallScript(fixture)
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/^diff --git /m)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    ['package.json', '{"name":"changed"}\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\nchanged: true\n'],
    ['pnpm-workspace.yaml', 'packages: []\nchanged: true\n']
  ])('rejects a changed %s when the composite step cwd is detached', (file, contents) => {
    const fixture = createFixture()
    try {
      const clean = executeInstallScript(fixture)
      expect(clean.status, clean.stderr || clean.stdout).toBe(0)

      writeFileSync(join(fixture.workspace, file), contents)
      const dirty = executeInstallScript(fixture)
      const output = `${dirty.stdout}\n${dirty.stderr}`
      expect(dirty.status).toBe(1)
      expect(output).toContain(`diff --git a/${file} b/${file}`)
      expect(output).not.toContain('diff --git a/package.json b/pnpm-lock.yaml')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
