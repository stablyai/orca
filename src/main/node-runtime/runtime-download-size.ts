import { getMainHttpClient } from '../network/http-client'

function identityLength(response: Response): number | null {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase() || 'identity'
  const bytes = Number(response.headers.get('content-length'))
  return encoding === 'identity' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/** The size a download will be, for progress and its size cap, without downloading it. */
export async function runtimeDownloadBytes(
  url: string,
  label: string,
  signal?: AbortSignal
): Promise<number> {
  const { fetch } = getMainHttpClient()
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal })
  if (!head.ok) {
    throw new Error(`${label} download size lookup failed (${head.status})`)
  }
  const listed = identityLength(head)
  if (listed !== null) {
    return listed
  }
  // Some CDNs (npm's) answer HEAD without a length but report the total for one byte.
  const ranged = await fetch(url, {
    headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal
  })
  await ranged.body?.cancel().catch(() => undefined)
  const total = Number(ranged.headers.get('content-range')?.match(/^bytes 0-0\/(\d+)$/)?.[1])
  if (ranged.status !== 206 || !Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`${label} download size is unknown`)
  }
  return total
}
