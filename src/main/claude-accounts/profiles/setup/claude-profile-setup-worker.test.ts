import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { JSONC_PARSER_ESM_ALIAS } from '../../../../../config/build-plugins/jsonc-parser-esm'
import { describeClaudeProfile } from '../claude-profile-paths'
import { runClaudeProfileSetupInWorker } from './claude-profile-setup-worker'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('runs account setup in the built worker entry, off the calling thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-setup-worker-'))
  roots.push(root)
  const userHome = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(join(userHome, '.claude'), { recursive: true })
  const profile = describeClaudeProfile(dataRoot, 'a', {
    executionHostId: 'local',
    runtime: 'host'
  })
  mkdirSync(profile.home, { recursive: true })
  const entry = join(root, 'claude-profile-setup-worker-entry.js')
  await build({
    entryPoints: [
      resolve('src/main/claude-accounts/profiles/setup/claude-profile-setup-worker-entry.ts')
    ],
    outfile: entry,
    bundle: true,
    alias: JSONC_PARSER_ESM_ALIAS,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })

  const report = await runClaudeProfileSetupInWorker(
    {
      dataRoot,
      profile,
      userHome,
      userConfigDir: undefined,
      hooks: false,
      claudeVersion: undefined
    },
    entry
  )

  expect(report.outcome).toBe('prepared')
  expect(existsSync(join(dataRoot, 'claude-profiles', 'a', 'profile.json'))).toBe(true)
  await expect(
    runClaudeProfileSetupInWorker(
      {
        dataRoot,
        profile,
        userHome,
        userConfigDir: undefined,
        hooks: false,
        claudeVersion: undefined
      },
      join(root, 'missing-entry.js')
    )
  ).rejects.toThrow()
})
