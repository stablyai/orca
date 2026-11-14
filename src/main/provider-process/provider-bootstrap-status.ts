import type { Readable } from 'node:stream'

export function readBootstrapStatus(stream: Readable): {
  initial: Promise<{ watcherPid: number; bootId: string }>
  ended: Promise<number | null>
  checkGated: () => void
} {
  let ready: (value: { watcherPid: number; bootId: string }) => void = () => {}
  let failReady: (error: Error) => void = () => {}
  let finish: (errno: number | null) => void = () => {}
  let failEnd: (error: Error) => void = () => {}
  const initial = new Promise<{ watcherPid: number; bootId: string }>((resolve, reject) => {
    ready = resolve
    failReady = reject
  })
  const ended = new Promise<number | null>((resolve, reject) => {
    finish = resolve
    failEnd = reject
  })
  void initial.catch(() => {})
  void ended.catch(() => {})
  let buffer = ''
  let bytes = 0
  let bootstrapped = false
  let errno: number | null = null
  let endedNormally = false
  let failed = false
  const fail = (): void => {
    failed = true
    const error = new Error('Invalid provider bootstrap status')
    failReady(error)
    failEnd(error)
  }
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 4096) {
      fail()
      stream.destroy()
      return
    }
    buffer += chunk.toString('utf8')
    let boundary: number
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 1)
      try {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object') {
          fail()
          return
        }
        if (
          !bootstrapped &&
          'watcherPid' in value &&
          typeof value.watcherPid === 'number' &&
          Number.isSafeInteger(value.watcherPid) &&
          value.watcherPid > 1 &&
          'bootId' in value &&
          typeof value.bootId === 'string' &&
          value.bootId.length > 0 &&
          value.bootId.length <= 255
        ) {
          bootstrapped = true
          ready({ watcherPid: value.watcherPid, bootId: value.bootId })
        } else if (
          bootstrapped &&
          errno === null &&
          'errno' in value &&
          typeof value.errno === 'number' &&
          Number.isSafeInteger(value.errno) &&
          value.errno > 0
        ) {
          errno = value.errno
        } else {
          fail()
          return
        }
      } catch {
        fail()
        return
      }
    }
  })
  stream.once('end', () => {
    endedNormally = true
    if (!bootstrapped || buffer.length) {
      fail()
    } else {
      finish(errno)
    }
  })
  stream.on('error', fail)
  stream.once('close', () => {
    if (!endedNormally) {
      fail()
    }
  })
  return {
    initial,
    ended,
    checkGated: () => {
      if (failed || endedNormally) {
        throw new Error('Provider bootstrap closed before gate release')
      }
    }
  }
}
