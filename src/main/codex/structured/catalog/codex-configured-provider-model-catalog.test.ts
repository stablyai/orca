import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { createCodexModelCatalogProbe } from './codex-model-catalog-probe'

it('lists configured provider models when Codex reports an empty native inventory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-codex-provider-catalog-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const profile = join(directory, 'local.config.toml')
  await writeFile(
    profile,
    'model = "local-model"\nmodel_provider = "local"\nmodel_reasoning_effort = "xhigh"'
  )
  await writeFile(
    join(directory, 'other.config.toml'),
    'model = "other"\nmodel_provider = "absent"'
  )
  await writeFile(join(directory, 'broken.config.toml'), 'model = [')
  const probe = createCodexModelCatalogProbe({
    resolveEnvironment: async () => ({}),
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    runSession: async (_invocation, body) =>
      body({
        request: async (method) => {
          switch (method) {
            case 'account/read':
              return { account: null, requiresOpenaiAuth: false }
            case 'model/list':
              return { data: [], nextCursor: null }
            case 'config/read':
              return {
                config: {
                  model_providers: {
                    local: { name: 'Local', base_url: 'http://localhost/v1?key=SECRET_SENTINEL' }
                  }
                }
              }
            default:
              throw new Error(`Unexpected Codex request ${method}`)
          }
        },
        notify: () => {}
      })
  })
  const listing = await probe({ variable: 'CODEX_HOME', path: directory }, { cwd: directory })
  expect(listing.models).toMatchObject([
    {
      id: 'codex-provider:["local","local-model"]',
      label: 'local-model · Local',
      efforts: [{ value: 'xhigh', label: 'Extra high' }]
    }
  ])
  expect(JSON.stringify(listing)).not.toContain('SECRET_SENTINEL')
  await rm(profile)
  await expect(
    probe({ variable: 'CODEX_HOME', path: directory }, { cwd: directory })
  ).rejects.toThrow('codex app-server listed no models')
})
