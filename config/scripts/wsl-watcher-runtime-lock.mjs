import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000
const DEFAULT_HEARTBEAT_STALE_MS = 10_000
const DEFAULT_RETRY_DELAY_MS = 25
const DEFAULT_TIMEOUT_MS = 30_000
const execFileAsync = promisify(execFile)

const defaultOperations = { mkdir, readFile, rename, rm, stat, writeFile }

function errorCode(error) {
  return error?.code
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function readOwner(lockPath, operations) {
  try {
    const parsed = JSON.parse(await operations.readFile(join(lockPath, 'owner.json'), 'utf8'))
    return typeof parsed?.token === 'string' && Number.isSafeInteger(parsed.pid) ? parsed : null
  } catch {
    return null
  }
}

async function processStartToken(pid) {
  try {
    if (process.platform === 'linux') {
      const contents = await readFile(`/proc/${pid}/stat`, 'utf8')
      return contents.slice(contents.lastIndexOf(') ') + 2).split(' ')[19] ?? null
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ],
        { encoding: 'utf8', timeout: 2_000, windowsHide: true }
      )
      return stdout.trim() || null
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

let currentProcessStartToken
function getProcessStartToken(pid) {
  if (pid !== process.pid) {
    return processStartToken(pid)
  }
  currentProcessStartToken ??= processStartToken(pid)
  return currentProcessStartToken
}

async function defaultOwnerIsAlive(owner) {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
  const actualStart = await getProcessStartToken(owner.pid)
  return !actualStart || !owner.processStartToken || actualStart === owner.processStartToken
}

async function heartbeatIsStale(lockPath, operations, now, staleMs) {
  try {
    const heartbeat = await operations.stat(join(lockPath, 'heartbeat'))
    return now() - heartbeat.mtimeMs >= staleMs
  } catch {
    try {
      const lock = await operations.stat(lockPath)
      return now() - lock.mtimeMs >= staleMs
    } catch {
      return true
    }
  }
}

async function quarantineOwnedLock(lockPath, expectedToken, operations, createToken, purpose) {
  const quarantine = `${lockPath}.${purpose}-${createToken()}`
  try {
    await operations.rename(lockPath, quarantine)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return true
    }
    return false
  }
  const movedOwner = await readOwner(quarantine, operations)
  if ((movedOwner?.token ?? null) !== expectedToken) {
    try {
      await operations.rename(quarantine, lockPath)
    } catch {
      // Preserve the displaced owner for diagnosis rather than deleting it.
    }
    return false
  }
  await operations.rm(quarantine, { recursive: true, force: true })
  return true
}

async function releaseOwnedLock(lockPath, token, operations, createToken) {
  const owner = await readOwner(lockPath, operations)
  if (owner?.token !== token) {
    return
  }
  await quarantineOwnedLock(lockPath, token, operations, createToken, 'release')
}

function startHeartbeat(lockPath, owner, operations, intervalMs) {
  const tick = async () => {
    const current = await readOwner(lockPath, operations)
    if (current?.token === owner.token) {
      await operations.writeFile(join(lockPath, 'heartbeat'), owner.token).catch(() => undefined)
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return timer
}

export async function withRuntimePublicationLock(
  lockPath,
  action,
  {
    operations: operationOverrides = {},
    createToken = randomUUID,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
    ownerIsAlive = defaultOwnerIsAlive,
    processId = process.pid,
    processStartToken: ownerStartToken,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now
  } = {}
) {
  const operations = { ...defaultOperations, ...operationOverrides }
  const token = createToken()
  const owner = {
    token,
    pid: processId,
    processStartToken: ownerStartToken ?? (await getProcessStartToken(processId))
  }
  const startedAt = now()
  let checkedOwnerToken = null
  let checkedOwnerAlive = null
  while (true) {
    try {
      await operations.mkdir(lockPath)
      try {
        await operations.writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner))
        await operations.writeFile(join(lockPath, 'heartbeat'), token)
      } catch (error) {
        await operations.rm(lockPath, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error
      }
      const incumbent = await readOwner(lockPath, operations)
      const stale = await heartbeatIsStale(lockPath, operations, now, heartbeatStaleMs)
      let alive = null
      if (incumbent) {
        if (incumbent.token === checkedOwnerToken && checkedOwnerAlive === true && !stale) {
          alive = true
        } else {
          alive = await ownerIsAlive(incumbent)
          checkedOwnerToken = incumbent.token
          checkedOwnerAlive = alive
        }
      }
      if (
        (alive === false || (alive === null && stale)) &&
        (await quarantineOwnedLock(
          lockPath,
          incumbent?.token ?? null,
          operations,
          createToken,
          'reclaim'
        ))
      ) {
        continue
      }
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for WSL watcher runtime publication lock: ${lockPath}`)
      }
      await delay(retryDelayMs)
    }
  }

  const heartbeat = startHeartbeat(lockPath, owner, operations, heartbeatIntervalMs)
  try {
    return await action()
  } finally {
    clearInterval(heartbeat)
    await releaseOwnedLock(lockPath, token, operations, createToken)
  }
}
