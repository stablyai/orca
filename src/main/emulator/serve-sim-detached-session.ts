import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { EmulatorError } from './emulator-errors'
import type { EmulatorSessionInfo } from './emulator-types'

const MJPEG_STREAM_SUFFIX = '/stream.mjpeg'
export const SERVE_SIM_STATE_FILE_MAX_BYTES = 8 * 1024

function streamUrlFromServeSimUrl(url: string): string {
  return url.endsWith(MJPEG_STREAM_SUFFIX) ? url : `${url.replace(/\/$/, '')}${MJPEG_STREAM_SUFFIX}`
}

// Derive the helper /ax endpoint by swapping the mjpeg stream suffix. Guarded to
// that suffix so a non-mjpeg stream URL never fabricates a bogus /ax endpoint.
export function deriveAxUrlFromStreamUrl(streamUrl: string | undefined): string | undefined {
  if (!streamUrl || !streamUrl.endsWith(MJPEG_STREAM_SUFFIX)) {
    return undefined
  }
  return `${streamUrl.slice(0, -MJPEG_STREAM_SUFFIX.length)}/ax`
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
    axUrl: typeof json.axUrl === 'string' ? json.axUrl : deriveAxUrlFromStreamUrl(streamUrl)
  }
  if (!info.streamUrl || !info.wsUrl) {
    throw new EmulatorError('emulator_helper_failed', 'serve-sim did not return stream endpoints.')
  }
  try {
    const statePath = join(tmpdir(), 'serve-sim', `server-${info.deviceUdid}.json`)
    const state = JSON.parse(
      readNodeFileSyncWithinLimit(statePath, SERVE_SIM_STATE_FILE_MAX_BYTES).buffer.toString('utf8')
    ) as { pid?: unknown }
    if (typeof state.pid === 'number') {
      info.helperPid = state.pid
    }
  } catch {}
  return info
}
