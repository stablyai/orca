import type { Readable } from 'node:stream'

export function readBootstrapStatus(stream: Readable): {
  initial: Promise<{ leaderPid: number; watcherPid: number }>
  ended: Promise<number | null>
  checkGated: () => void
} {
  let ready: (value: { leaderPid: number; watcherPid: number }) => void = () => {}
  let failReady: (error: Error) => void = () => {}
  let finish: (errno: number | null) => void = () => {}
  let failEnd: (error: Error) => void = () => {}
  const initial = new Promise<{ leaderPid: number; watcherPid: number }>((resolve, reject) => {
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
          'leaderPid' in value &&
          typeof value.leaderPid === 'number' &&
          Number.isSafeInteger(value.leaderPid) &&
          value.leaderPid > 1 &&
          'watcherPid' in value &&
          typeof value.watcherPid === 'number' &&
          Number.isSafeInteger(value.watcherPid) &&
          value.watcherPid > 1
        ) {
          bootstrapped = true
          ready({ leaderPid: value.leaderPid, watcherPid: value.watcherPid })
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

export async function withProviderBootstrapDeadline(start: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider ownership startup timed out')), 15_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
