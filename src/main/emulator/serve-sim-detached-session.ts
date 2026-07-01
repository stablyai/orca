import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'

function streamUrlFromServeSimUrl(url: string): string {
  return url.endsWith('/stream.mjpeg') ? url : `${url.replace(/\/$/, '')}/stream.mjpeg`
}

export function parseServeSimDetachedSession(raw: unknown, udid: string): EmulatorSessionInfo {
  if (!raw || typeof raw !== 'object') {
    throw new EmulatorError('emulator_helper_failed', 'serve-sim did not return stream endpoints.')
  }
  const json = raw as Record<string, unknown>
  const wsUrl = typeof json.wsUrl === 'string' ? json.wsUrl : undefined
  const streamUrl =
    typeof json.streamUrl === 'string'
      ? json.streamUrl
      : typeof json.url === 'string'
        ? streamUrlFromServeSimUrl(json.url)
        : undefined
  const info: EmulatorSessionInfo = {
    deviceUdid: typeof json.device === 'string' ? json.device : udid,
    wsUrl: wsUrl ?? '',
    streamUrl: streamUrl ?? '',
    axUrl: typeof json.axUrl === 'string' ? json.axUrl : undefined
  }
  if (!info.streamUrl || !info.wsUrl) {
    throw new EmulatorError('emulator_helper_failed', 'serve-sim did not return stream endpoints.')
  }
  try {
    const statePath = join(tmpdir(), 'serve-sim', `server-${info.deviceUdid}.json`)
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { pid?: unknown }
      if (typeof state.pid === 'number') {
        info.helperPid = state.pid
      }
    }
  } catch {}
  return info
}
