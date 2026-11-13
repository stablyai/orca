import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitSigningOffEnv } from './vitest-git-signing-env.mjs'

const cleanup = []

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

it('commits and tags unsigned under a signing global config, keeping its other settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-git-signing-env-'))
  cleanup.push(root)
  const globalConfig = join(root, 'global.gitconfig')
  // Forward slashes: a backslash starts an escape in a gitconfig value.
  const missingSigner = join(root, 'missing-signer').replaceAll('\\', '/')
  writeFileSync(
    globalConfig,
    `[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n\tforceSignAnnotated = true\n[gpg]\n\tprogram = ${missingSigner}\n[user]\n\tname = Test\n\temail = test@example.invalid\n`
  )
  const inherited = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const env = { ...inherited, ...gitSigningOffEnv(inherited) }
  cleanup.push(dirname(env.GIT_CONFIG_GLOBAL))
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim()

  git('init', '--quiet')
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture')
  git('tag', 'v1.0.0')
  git('tag', '-m', 'release', 'v1.0.1')

  expect(git('cat-file', '-t', 'v1.0.0')).toBe('commit')
  expect(git('log', '-1', '--format=%an %G?')).toBe('Test N')
  expect(gitSigningOffEnv({ ...inherited, GIT_CONFIG_GLOBAL: join(root, 'missing') })).toEqual({})
})
