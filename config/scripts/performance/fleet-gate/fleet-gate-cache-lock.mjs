// Gate runs on one machine share ~/.cache/orca-fleet-gate; a lock keeps two runs from building the same entry at once.
import fs from 'node:fs'

const POLL_MS = 5_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))

const ownerAlive = (lockDir) => {
  try {
    const pid = Number(fs.readFileSync(`${lockDir}/pid`, 'utf8'))
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // The owner made the lock but hasn't written its pid yet, unless it died in between long ago.
      return Date.now() - (fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? 0) < 60_000
    }
    // EPERM: the pid exists under another user.
    return error?.code === 'EPERM'
  }
}

/** Takes `<entry>.lock` (mkdir is atomic), waiting while a live run holds it; a dead owner's lock is taken over. */
export function lockCacheEntry(entryDir) {
  const lockDir = `${entryDir}.lock`
  let announced = false
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(`${lockDir}/pid`, String(process.pid))
      return () => fs.rmSync(lockDir, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
    }
    if (!ownerAlive(lockDir)) {
      fs.rmSync(lockDir, { recursive: true, force: true })
      continue
    }
    if (!announced) {
      console.log(`[fleet-gate] waiting for another gate run to finish ${entryDir}`)
      announced = true
    }
    Atomics.wait(sleeper, 0, 0, POLL_MS)
  }
}
