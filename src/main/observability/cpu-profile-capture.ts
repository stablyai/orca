import type { WebContents } from 'electron'
import { stat, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireElectronDebugger } from '../browser/electron-debugger-lease'
import type { TarArchiveEntry } from './tar-archive'

export type PerfArtifactStatus = {
  readonly status: 'included' | 'omitted' | 'failed'
  readonly fileName?: string
  readonly bytes?: number
  readonly reason?: string
}

const PROFILE_DURATION_MS = 10_000
// 1000 µs is the DevTools default; it keeps a 10 s profile in the low
// single-digit MB so the report stays attachable/sendable.
const PROFILE_SAMPLING_INTERVAL_US = 1000
// Why: a wedged process can stall ANY inspector command indefinitely — the
// exact state this feature exists to diagnose. One budget over the whole
// command sequence turns that into a failure note instead of a capture that
// never settles (which would strand the single-flight latch until restart).
export const PROFILE_CAPTURE_TIMEOUT_MS = PROFILE_DURATION_MS + 35_000

export async function captureRendererProfileArtifact(
  captureDir: string,
  getRendererWebContents: () => WebContents | null,
  artifacts: Record<string, PerfArtifactStatus>,
  entries: TarArchiveEntry[],
  captureTimeoutMs: number
): Promise<void> {
  const fileName = 'renderer.cpuprofile'
  const filePath = join(captureDir, fileName)
  const renderer = getRendererWebContents()
  if (!renderer || renderer.isDestroyed()) {
    artifacts.renderer_profile = { status: 'omitted', reason: 'renderer unavailable' }
    return
  }
  let lease: { release: () => void } | null = null
  try {
    lease = acquireElectronDebugger(renderer)
    const dbg = renderer.debugger
    // Why: a timed-out loser keeps running but only touches its own locals
    // and its own file, so it cannot corrupt the archive assembled after the
    // budget fires; the pre-attached catch absorbs its late rejection.
    const work = (async () => {
      await dbg.sendCommand('Profiler.enable')
      await dbg.sendCommand('Profiler.setSamplingInterval', {
        interval: PROFILE_SAMPLING_INTERVAL_US
      })
      await dbg.sendCommand('Profiler.start')
      await delay(PROFILE_DURATION_MS)
      const result = (await dbg.sendCommand('Profiler.stop')) as { profile?: unknown }
      if (!result || typeof result !== 'object' || !result.profile) {
        throw new Error('profiler returned no profile')
      }
      await writeFile(filePath, JSON.stringify(result.profile), { encoding: 'utf8', mode: 0o600 })
      return stat(filePath)
    })()
    work.catch(() => {})
    const info = await withTimeout(work, captureTimeoutMs)
    artifacts.renderer_profile = { status: 'included', fileName, bytes: info.size }
    entries.push({ name: fileName, filePath })
  } catch (error) {
    artifacts.renderer_profile = { status: 'failed', reason: formatProfileFailure(error) }
  } finally {
    if (!renderer.isDestroyed()) {
      // Why: awaiting disable would reopen the wedged-renderer hang the
      // budget above just closed; a late fire-and-forget disable is harmless.
      renderer.debugger.sendCommand('Profiler.disable').catch(() => {})
    }
    lease?.release()
  }
}

export async function captureMainProfileArtifact(
  captureDir: string,
  artifacts: Record<string, PerfArtifactStatus>,
  entries: TarArchiveEntry[],
  captureTimeoutMs: number
): Promise<void> {
  const fileName = 'main.cpuprofile'
  const filePath = join(captureDir, fileName)
  // Why: the renderer profiler can't see main-process stalls (the frozen
  // loading-screen class); an in-process inspector session captures them.
  const session = new Session()
  let connected = false
  try {
    session.connect()
    connected = true
    const work = (async () => {
      await postToInspector(session, 'Profiler.enable')
      await postToInspector(session, 'Profiler.setSamplingInterval', {
        interval: PROFILE_SAMPLING_INTERVAL_US
      })
      await postToInspector(session, 'Profiler.start')
      await delay(PROFILE_DURATION_MS)
      const result = (await postToInspector(session, 'Profiler.stop')) as { profile?: unknown }
      if (!result || typeof result !== 'object' || !result.profile) {
        throw new Error('profiler returned no profile')
      }
      await writeFile(filePath, JSON.stringify(result.profile), { encoding: 'utf8', mode: 0o600 })
      return stat(filePath)
    })()
    work.catch(() => {})
    const info = await withTimeout(work, captureTimeoutMs)
    artifacts.main_profile = { status: 'included', fileName, bytes: info.size }
    entries.push({ name: fileName, filePath })
  } catch (error) {
    artifacts.main_profile = { status: 'failed', reason: formatProfileFailure(error) }
  } finally {
    if (connected) {
      try {
        // Why: disconnect also rejects any post the budget abandoned, which
        // the pre-attached catch on `work` absorbs.
        session.disconnect()
      } catch {
        /* best effort */
      }
    }
  }
}

function postToInspector(session: Session, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error: Error | null, result?: unknown) => {
      if (error) {
        reject(error)
      } else {
        resolve(result)
      }
    })
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function formatProfileFailure(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 200) : 'unavailable'
}
