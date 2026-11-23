import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lock } from 'proper-lockfile'

const LEASE_ENV = 'ORCA_LOCAL_CHECK_LEASE'
const host = hostname()
const hostKey = createHash('sha256').update(`${homedir()}:${host}`).digest('hex').slice(0, 16)
const hostDirectory = join(homedir(), '.cache', 'orca', `local-checks-${hostKey}`)

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false
    }
    if (error.code === 'EPERM') {
      return true
    }
    throw error
  }
}

async function readLease(file) {
  try {
    const lease = JSON.parse(await readFile(file, 'utf8'))
    if (!Number.isSafeInteger(lease.pid) || lease.pid < 1) {
      throw new Error(`Invalid local check lease: ${file}`)
    }
    return lease.host === host ? lease : null
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function reserve(directory) {
  let release
  try {
    release = await lock(join(directory, 'admission'), {
      realpath: false,
      stale: 60_000,
      retries: 0
    })
  } catch (error) {
    if (error.code === 'ELOCKED') {
      return null
    }
    throw error
  }
  try {
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) {
        continue
      }
      const file = join(directory, name)
      const lease = await readLease(file)
      if (lease && isAlive(lease.pid)) {
        return null
      }
      await rm(file, { force: true })
    }
    const file = join(directory, `${randomUUID()}.json`)
    const pending = `${file}.pending`
    try {
      await writeFile(pending, JSON.stringify({ pid: process.pid, host }), {
        flag: 'wx',
        mode: 0o600
      })
      await rename(pending, file)
      return file
    } finally {
      await rm(pending, { force: true })
    }
  } finally {
    await release()
  }
}

/** One check group per local host; nested check scripts reuse their parent's reservation. */
export async function withLocalCheckSlot(
  run,
  {
    directory = hostDirectory,
    env = process.env,
    signal,
    onWait = () => console.error('Waiting for another Orca development check to finish…')
  } = {}
) {
  signal?.throwIfAborted()
  const inherited = env[LEASE_ENV]
  if (inherited) {
    const lease = await readLease(inherited)
    if (lease && isAlive(lease.pid)) {
      signal?.throwIfAborted()
      return run()
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let file
  let reported = false
  while (!(file = await reserve(directory))) {
    if (!reported) {
      onWait()
      reported = true
    }
    await delay(1000, undefined, { signal })
  }
  env[LEASE_ENV] = file
  try {
    signal?.throwIfAborted()
    return await run()
  } finally {
    if (inherited === undefined) {
      delete env[LEASE_ENV]
    } else {
      env[LEASE_ENV] = inherited
    }
    await rm(file, { force: true })
  }
}
