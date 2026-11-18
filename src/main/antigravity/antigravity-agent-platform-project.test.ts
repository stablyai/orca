import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAgentPlatformProject } from './antigravity-agent-platform-project'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function gcloud(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gcloud-'))
  dirs.push(dir)
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

describe('resolveAgentPlatformProject', () => {
  it("uses ADC's quota project, else gcloud's active project, with the global location", async () => {
    const config = gcloud({
      active_config: 'work\n',
      'configurations/config_work': '[compute]\nproject = wrong\n[core]\nproject = from-gcloud\n'
    })
    await expect(resolveAgentPlatformProject({}, { CLOUDSDK_CONFIG: config })).resolves.toEqual({
      project: 'from-gcloud',
      location: 'global'
    })
    writeFileSync(
      join(config, 'application_default_credentials.json'),
      JSON.stringify({ quota_project_id: 'from-adc' })
    )
    await expect(resolveAgentPlatformProject({}, { CLOUDSDK_CONFIG: config })).resolves.toEqual({
      project: 'from-adc',
      location: 'global'
    })
  })

  it('prefers saved values, then the launch environment', async () => {
    const env = {
      CLOUDSDK_CONFIG: gcloud({}),
      GOOGLE_CLOUD_PROJECT: 'from-env',
      GOOGLE_CLOUD_LOCATION: 'us'
    }
    await expect(resolveAgentPlatformProject({}, env)).resolves.toEqual({
      project: 'from-env',
      location: 'us'
    })
    await expect(
      resolveAgentPlatformProject({ gcpProject: 'saved', gcpLocation: 'eu' }, env)
    ).resolves.toEqual({ project: 'saved', location: 'eu' })
  })

  it('reports no project when gcloud has none', async () => {
    await expect(resolveAgentPlatformProject({}, { CLOUDSDK_CONFIG: gcloud({}) })).resolves.toEqual(
      { project: null, location: 'global' }
    )
  })
})
