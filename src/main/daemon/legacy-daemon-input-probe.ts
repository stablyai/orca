import { randomUUID } from 'node:crypto'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

const LEGACY_INPUT_PROBE_TIMEOUT_MS = 2_500
const LEGACY_INPUT_PROBE_ATTEMPTS = 2

async function runLegacyDaemonInputProbe(
  adapter: DaemonPtyAdapter,
  cwd: string
): Promise<boolean | null> {
  const probeId = `orca-legacy-input-probe-${randomUUID()}`
  const token = `orca-legacy-input-ok-${randomUUID()}`
  let spawned = false
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let settle: ((healthy: boolean) => void) | null = null
  const observed = new Promise<boolean>((resolve) => {
    settle = resolve
    timer = setTimeout(() => resolve(false), LEGACY_INPUT_PROBE_TIMEOUT_MS)
  })
  const unsubscribeData = adapter.onData(({ id, data }) => {
    if (id !== probeId) {
      return
    }
    buffer = (buffer + data).slice(-token.length * 2)
    if (buffer.includes(token)) {
      settle?.(true)
    }
  })
  const unsubscribeExit = adapter.onExit(({ id }) => {
    if (id === probeId && !buffer.includes(token)) {
      settle?.(false)
    }
  })

  try {
    await adapter.spawn({
      sessionId: probeId,
      cols: 20,
      rows: 2,
      cwd,
      command: `printf '%s\\n' '${token}'; exit`,
      commandDelivery: 'provider'
    })
    spawned = true
    return await observed
  } catch {
    return null
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    unsubscribeData()
    unsubscribeExit()
    if (spawned) {
      try {
        await adapter.shutdown(probeId, {
          immediate: true,
          keepHistory: false,
          deadlineMs: Date.now() + LEGACY_INPUT_PROBE_TIMEOUT_MS
        })
      } catch {
        // Probe cleanup is best-effort. The unminted session is also rejected
        // by normal startup reconciliation and cannot route a user pane.
      }
    }
  }
}

export async function probeLegacyDaemonInput(
  adapter: DaemonPtyAdapter,
  cwd: string
): Promise<boolean> {
  for (let attempt = 0; attempt < LEGACY_INPUT_PROBE_ATTEMPTS; attempt++) {
    const result = await runLegacyDaemonInputProbe(adapter, cwd)
    if (result === true) {
      return true
    }
    if (result === null) {
      return false
    }
  }
  return false
}
