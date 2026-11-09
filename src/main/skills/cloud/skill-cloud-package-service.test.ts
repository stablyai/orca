import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillCloudService } from './skill-cloud-package-service'

const { packaged } = vi.hoisted(() => ({ packaged: { value: false } }))
const createdPaths: string[] = []

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged.value
    }
  }
}))

afterEach(() => {
  for (const path of createdPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  packaged.value = false
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function userDataPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-skill-cloud-service-'))
  createdPaths.push(path)
  return path
}

describe('SkillCloudService bearer links', () => {
  it('uses the development auth token without opening a profile session', async () => {
    vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        requests.push(init ?? {})
        return Response.json({ shares: [] })
      })
    )

    await expect(
      new SkillCloudService(userDataPath()).listOwnedShares({ apiUrl: 'http://127.0.0.1:8787' })
    ).resolves.toEqual({ status: 'ok', value: [] })

    expect(new Headers(requests[0]?.headers).get('authorization')).toBe('Bearer desktop-e2e-token')
  })

  it('rejects the development auth token in packaged builds', async () => {
    packaged.value = true
    vi.stubEnv('ORCA_CLOUD_AUTH_TOKEN', 'desktop-e2e-token')

    await expect(
      new SkillCloudService(userDataPath()).listOwnedShares({ apiUrl: 'https://share.onorca.dev' })
    ).rejects.toThrow('available only in development builds')
  })
})
