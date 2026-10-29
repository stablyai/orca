import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EmulatorError } from './emulator-errors'
import { emulatorFailureText } from '../../shared/emulator-failure-copy'
import type { EmulatorSessionInfo } from './emulator-types'

const MJPEG_STREAM_SUFFIX = '/stream.mjpeg'

function streamUrlFromServeSimUrl(url: string): string {
  return url.endsWith(MJPEG_STREAM_SUFFIX) ? url : `${url.replace(/\/$/, '')}${MJPEG_STREAM_SUFFIX}`
}

// Derive /ax only from MJPEG URLs to avoid fabricating endpoints for other stream types.
export function deriveAxUrlFromStreamUrl(streamUrl: string | undefined): string | undefined {
  if (!streamUrl || !streamUrl.endsWith(MJPEG_STREAM_SUFFIX)) {
    return undefined
  }
  return `${streamUrl.slice(0, -MJPEG_STREAM_SUFFIX.length)}/ax`
}

export function parseServeSimDetachedSession(raw: unknown, udid: string): EmulatorSessionInfo {
  if (!raw || typeof raw !== 'object') {
    throw new EmulatorError('emulator_helper_failed', emulatorFailureText('serveSimNoEndpoints'))
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
    axUrl: typeof json.axUrl === 'string' ? json.axUrl : deriveAxUrlFromStreamUrl(streamUrl)
  }
  if (!info.streamUrl || !info.wsUrl) {
    throw new EmulatorError('emulator_helper_failed', emulatorFailureText('serveSimNoEndpoints'))
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
