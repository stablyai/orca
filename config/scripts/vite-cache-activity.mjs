import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'

export const VITE_CACHE_USAGE_DIRECTORY = '.orca-vite-cache-v1'
// Windows and WSL can share a hostname while using separate PID namespaces.
export const VITE_CACHE_HOST_ID = createHash('sha256')
  .update(JSON.stringify([process.platform, hostname(), process.env.WSL_DISTRO_NAME ?? '']))
  .digest('hex')

export async function withViteCacheLock(cacheRoot, action, retries = 100) {
  await mkdir(dirname(cacheRoot), { recursive: true })
  let compromised
  const release = await lock(cacheRoot, {
    realpath: false,
    stale: 60_000,
    retries: { retries, minTimeout: 50, maxTimeout: 250 },
    onCompromised: (error) => {
      compromised = error
    }
  })
  const verify = () => {
    if (compromised) {
      throw compromised
    }
  }
  try {
    verify()
    const result = await action(verify)
    verify()
    return result
  } finally {
    if (!compromised) {
      await release()
    }
  }
}

export async function retainViteCache(cacheRoot) {
  const usage = join(cacheRoot, VITE_CACHE_USAGE_DIRECTORY)
  const owner = join(usage, `${VITE_CACHE_HOST_ID}-${process.pid}-${randomUUID()}`)
  await withViteCacheLock(cacheRoot, async (verify) => {
    await mkdir(dirname(owner), { recursive: true })
    verify()
    await writeFile(owner, '', { flag: 'wx' })
    await utimes(usage, new Date(), new Date())
  })
  return () =>
    withViteCacheLock(cacheRoot, async (verify) => {
      verify()
      await rm(owner, { force: true })
      await utimes(usage, new Date(), new Date())
    })
}
