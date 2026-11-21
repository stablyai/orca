import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AsyncWrite from '../../shared/secure-storage/secure-file-async-write'
import type * as FsPromises from 'node:fs/promises'

// Faults land on the real writers: before a staged file is renamed into place, or as an intent is removed.
type Faults = {
  beforeStage?: (path: string) => Promise<void>
  beforePublish?: (path: string) => void
  beforeRemove?: (path: string) => void
}
const faults = vi.hoisted((): Faults => ({}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../shared/secure-storage/secure-file-async-write', async (importOriginal) => {
  const actual = await importOriginal<typeof AsyncWrite>()
  return {
    ...actual,
    writeSecureFileAsync: async (
      ...[path, contents, options = {}]: Parameters<typeof actual.writeSecureFileAsync>
    ) => {
      await faults.beforeStage?.(path)
      return actual.writeSecureFileAsync(path, contents, {
        ...options,
        shouldPublish: () => {
          faults.beforePublish?.(path)
          return options.shouldPublish?.() ?? true
        }
      })
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      faults.beforeRemove?.(String(args[0]))
      return actual.rm(...args)
    }
  }
})

import type { OrcaProfileCloudSummary } from '../../shared/orca-profiles/orca-profiles'
import {
  createLocalOrcaProfile,
  ensureActiveOrcaProfile,
  setActiveOrcaProfile
} from '../orca-profiles/profile-index-store'
import {
  linkOrcaProfileToCloud,
  unlinkOrcaProfileFromCloud
} from '../orca-profiles/cloud-auth/profile-cloud-index'
import { signOutCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { saveOrcaCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-store'
import { getOrcaProfileDirectory } from '../orca-profiles/profile-storage-paths'

const apiUrl = 'http://localhost:3000'
const now = Date.UTC(2026, 7, 7, 12)
const cloud: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-a',
  userId: 'user-a',
  email: 'a@example.com',
  linkedAt: 1
}
const crash = (): never => {
  throw new Error('simulated crash')
}
const request = (sourceKey = '/repo/report.html') => ({
  sourceKey,
  content: `<h1>${sourceKey}</h1>`,
  contentType: 'text/html' as const,
  fileName: 'report.html',
  apiUrl
})

type Account = { userDataPath: string; profileId: string }
let account: Account
let server: FakeArtifactServer

/** A new process: every module, cache and queue starts over from what is on disk. */
async function restartedService() {
  vi.resetModules()
  const { ArtifactCloudService } = await import('./artifact-cloud-service')
  return new ArtifactCloudService(account.userDataPath, () => true)
}

function profileFile(...parts: string[]): string {
  return join(getOrcaProfileDirectory(account.profileId, account.userDataPath), ...parts)
}

async function intentFiles(): Promise<string[]> {
  return readdir(profileFile('artifact-create-intents')).catch(() => [])
}

async function sharedSources(): Promise<string[]> {
  const text = await readFile(profileFile('artifact-shares.json'), 'utf8').catch(() => '{}')
  const file: unknown = JSON.parse(text)
  const shares: unknown =
    file && typeof file === 'object' && 'shares' in file ? file.shares : undefined
  return shares && typeof shares === 'object' ? Object.keys(shares).sort() : []
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  vi.stubEnv('ORCA_CLOUD_API_URL', apiUrl)
  vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'orca-test')
  vi.stubEnv('ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION', '1')
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-artifact-faults-'))
  const profileId = ensureActiveOrcaProfile(userDataPath).profile.id
  linkOrcaProfileToCloud(profileId, cloud, userDataPath)
  saveOrcaCloudSession(profileId, userDataPath, {
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    expiresAt: now + 60 * 60 * 1000,
    capabilities: { flags: {}, refreshedAt: now }
  })
  account = { userDataPath, profileId }
  server = new FakeArtifactServer()
  vi.stubGlobal('fetch', server.fetch)
})

afterEach(async () => {
  vi.useRealTimers()
  faults.beforeStage = faults.beforePublish = faults.beforeRemove = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(account.userDataPath, { recursive: true, force: true })
})

describe('artifact publish crash points', () => {
  it('sends nothing when the intent never became durable', async () => {
    faults.beforePublish = (path) => path.endsWith('.json') && path.includes('intents') && crash()
    await expect((await restartedService()).publish(request())).rejects.toThrow('simulated crash')
    faults.beforePublish = undefined
    expect(server.posts).toEqual([])
    expect(await intentFiles()).toEqual([])

    await (await restartedService()).publish(request())
    expect(server.slugs()).toEqual(['artifact-1'])
  })

  it('replays the durable intent with its key when the request never left', async () => {
    server.failNextPostBeforeCommit = true
    await expect((await restartedService()).publish(request())).rejects.toThrow('network down')
    expect(await intentFiles()).toHaveLength(1)

    await (await restartedService()).publish(request())
    expect(server.posts).toHaveLength(2)
    expect(server.posts[1]).toBe(server.posts[0])
    expect(server.slugs()).toEqual(['artifact-1'])
    expect(await intentFiles()).toEqual([])
  })

  it('does not create twice when the record write fails after the POST committed', async () => {
    faults.beforePublish = (path) => path.endsWith('artifact-shares.json') && crash()
    await expect((await restartedService()).publish(request())).rejects.toThrow('simulated crash')
    faults.beforePublish = undefined
    expect(server.slugs()).toEqual(['artifact-1'])
    expect(await sharedSources()).toEqual([])
    expect(await intentFiles()).toHaveLength(1)

    await (await restartedService()).publish(request())
    expect(server.slugs()).toEqual(['artifact-1'])
    expect(await sharedSources()).toEqual(['/repo/report.html'])
    expect(await intentFiles()).toEqual([])
  })

  it('keeps the record and finishes the removal when the intent outlived it', async () => {
    faults.beforeRemove = (path) => path.includes('intents') && crash()
    await expect((await restartedService()).publish(request())).rejects.toThrow('simulated crash')
    faults.beforeRemove = undefined
    expect(await sharedSources()).toEqual(['/repo/report.html'])
    expect(await intentFiles()).toHaveLength(1)

    await (await restartedService()).publish(request())
    expect(server.slugs()).toEqual(['artifact-1'])
    expect(await sharedSources()).toEqual(['/repo/report.html'])
    expect(await intentFiles()).toEqual([])
  })
})

describe('artifact share index writers', () => {
  it('keeps every record when sources publish while one index write waits on the disk', async () => {
    let releaseFirst = (): void => {}
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let held = false
    faults.beforeStage = async (path) => {
      if (path.endsWith('artifact-shares.json') && !held) {
        held = true
        await firstHeld
      }
    }
    const service = await restartedService()
    const sources = ['/repo/a.html', '/repo/b.html', '/repo/c.html', '/repo/d.html']
    const published = Promise.all(sources.map((source) => service.publish(request(source))))
    await vi.waitUntil(() => server.slugs().length === sources.length)
    releaseFirst()
    await published
    expect(await sharedSources()).toEqual(sources)
  })
})

describe('artifact writes in flight when the account changes', () => {
  const changes = {
    'sign-out': () => {
      signOutCloudSession(account.profileId, account.userDataPath)
      unlinkOrcaProfileFromCloud(account.profileId, account.userDataPath)
    },
    'profile switch': () => {
      setActiveOrcaProfile(
        createLocalOrcaProfile({}, account.userDataPath).profile.id,
        account.userDataPath
      )
    }
  }

  it('sends nothing when sign-out has started but remote logout has not finished', async () => {
    const service = await restartedService()
    // The restarted service holds its own session ticket, so sign out through its module graph.
    const owner = await import('../orca-profiles/cloud-session/profile-cloud-session-owner')
    faults.beforePublish = (path) =>
      path.includes('intents') && owner.signOutCloudSession(account.profileId, account.userDataPath)
    await expect(service.publish(request())).rejects.toThrow('account changed')
    expect(server.posts).toEqual([])
    expect(await intentFiles()).toEqual([])
  })

  for (const [name, change] of Object.entries(changes)) {
    it(`publishes no intent and sends nothing after a ${name} during the intent write`, async () => {
      faults.beforePublish = (path) => path.includes('intents') && change()
      const outcome = (await restartedService()).publish(request())
      await expect(outcome).rejects.toThrow('account changed')
      expect(server.posts).toEqual([])
      expect(await intentFiles()).toEqual([])
    })

    it(`publishes no record after a ${name} during the record write`, async () => {
      faults.beforePublish = (path) => path.endsWith('artifact-shares.json') && change()
      const outcome = (await restartedService()).publish(request())
      await expect(outcome).rejects.toThrow('account changed')
      expect(await sharedSources()).toEqual([])
    })
  }
})

class FakeArtifactServer {
  readonly posts: string[] = []
  failNextPostBeforeCommit = false
  private readonly bySlug = new Map<string, string>()
  private readonly slugByKey = new Map<string, string>()

  readonly fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method !== 'POST') {
      throw new Error(`unexpected artifact request: ${init.method}`)
    }
    const key = new Headers(init.headers).get('idempotency-key') ?? ''
    this.posts.push(key)
    if (this.failNextPostBeforeCommit) {
      this.failNextPostBeforeCommit = false
      throw new TypeError('network down')
    }
    let slug = this.slugByKey.get(key)
    if (!slug) {
      slug = `artifact-${this.bySlug.size + 1}`
      this.slugByKey.set(key, slug)
      this.bySlug.set(slug, String(init.body))
    }
    return Response.json({
      artifact: {
        version: 1,
        slug,
        title: null,
        originalFileName: 'report.html',
        sourceContentType: 'text/html',
        renderedContentType: 'text/html',
        createdAt: '2026-08-07T12:00:00.000Z',
        updatedAt: '2026-08-07T12:00:00.000Z',
        expiresAt: '2026-09-07T00:00:00.000Z',
        byteSize: 12,
        deletedAt: null
      },
      shareUrl: `https://share.onorca.dev/a/${slug}`,
      editToken: `edit-${slug}`
    })
  })

  slugs(): string[] {
    return [...this.bySlug.keys()].sort()
  }
}
