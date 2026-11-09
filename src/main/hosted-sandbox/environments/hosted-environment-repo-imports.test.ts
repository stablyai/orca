import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRepoSetupImports } from './hosted-environment-repo-imports'
import { toHostedEnvironmentError } from './hosted-environment-service'

let base: string
let repo: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'orca-env-imports-'))
  repo = join(base, 'repo')
  outside = join(base, 'outside')
  await mkdir(repo)
  await mkdir(outside)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const devcontainer = (name: string) =>
  JSON.stringify({ postCreateCommand: 'npm ci', containerEnv: { [name]: 'value' } })

describe('readRepoSetupImports', () => {
  it('reads names and a setup script from a registered repo', async () => {
    await mkdir(join(repo, '.devcontainer'))
    await writeFile(join(repo, '.devcontainer/devcontainer.json'), devcontainer('NPM_TOKEN'))
    const result = await readRepoSetupImports(repo, [repo])
    expect(result.envVarNames).toEqual(['NPM_TOKEN'])
    expect(result.installScript).toContain('npm ci')
    expect(result.sources).toEqual([
      'Dev Container (.devcontainer/devcontainer.json)',
      'Environment variable names (.devcontainer/devcontainer.json)'
    ])
  })

  it('refuses a folder that is not a project in Orca', async () => {
    const error = await readRepoSetupImports(outside, [repo]).catch((e: unknown) => e)
    expect(toHostedEnvironmentError(error)).toMatchObject({
      code: 'not_found',
      reason: 'repo_not_registered'
    })
    const relative = await readRepoSetupImports('repo', [repo]).catch((e: unknown) => e)
    expect(toHostedEnvironmentError(relative).code).toBe('invalid_request')
  })

  it('ignores config reached through a symlink that leaves the repo', async () => {
    await mkdir(join(outside, 'dc'))
    await writeFile(join(outside, 'dc/devcontainer.json'), devcontainer('LEAKED_NAME'))
    await symlink(join(outside, 'dc'), join(repo, '.devcontainer'))
    await writeFile(join(outside, 'secrets.env'), 'OUTSIDE_SECRET=1\n')
    await symlink(join(outside, 'secrets.env'), join(repo, '.env.example'))
    const result = await readRepoSetupImports(repo, [repo])
    expect(result.envVarNames).toEqual([])
    expect(result.installScript).toBeUndefined()
    expect(result.sources).toEqual([])
  })

  it('follows a symlink that stays inside the repo', async () => {
    await mkdir(join(repo, 'config'))
    await writeFile(join(repo, 'config/env.example'), 'INSIDE_NAME=\n')
    await symlink(join(repo, 'config/env.example'), join(repo, '.env.example'))
    const result = await readRepoSetupImports(repo, [repo])
    expect(result.envVarNames).toEqual(['INSIDE_NAME'])
  })
})
