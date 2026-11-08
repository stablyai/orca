import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SkillCloudService } from '../cloud/skill-cloud-package-service'
import { SkillSharePreparationService } from './skill-share-preparation'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const API_URL = 'http://127.0.0.1:8787'
let root = ''
let source = ''
let lookups: string[] = []

function stubLookup(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | RequestInfo) => {
      lookups.push(new URL(String(input)).pathname)
      return Response.json(body, { status })
    })
  )
}

function service(): SkillSharePreparationService {
  const cloud = new SkillCloudService(root)
  return new SkillSharePreparationService(join(root, 'preparations'), {
    findOwnedPackageId: (name) => cloud.findOwnedPackageId(name, { apiUrl: API_URL }),
    publishVersion: vi.fn(),
    createShare: vi.fn()
  })
}

beforeEach(async () => {
  vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')
  root = await mkdtemp(join(tmpdir(), 'orca-skill-share-name-'))
  source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), '---\nname: lw-skill\ndescription: d\n---\n# d\n')
  lookups = []
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

describe('skill share package id by name', () => {
  it('fails the share on any other lookup failure instead of guessing a new id', async () => {
    stubLookup(503, { code: 'skill_service_unavailable' })

    await expect(
      service().prepare({ sourceDirectory: source, bundleName: 'lw-test' })
    ).rejects.toMatchObject({ statusCode: 503 })
  })
})
