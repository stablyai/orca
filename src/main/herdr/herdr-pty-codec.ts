import { Buffer } from 'node:buffer'
import type { HerdrTerminalFrame } from './herdr-runtime-contract'
import type { HerdrPtyBinding, HerdrPtyIdentity } from './herdr-pty-types'

const HERDR_PTY_PREFIX = 'herdr:'

export function encodeHerdrPtyId(identity: HerdrPtyIdentity): string {
  return `${HERDR_PTY_PREFIX}${Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url')}`
}

export function decodeHerdrPtyId(id: string): HerdrPtyIdentity | null {
  if (!id.startsWith(HERDR_PTY_PREFIX)) {
    return null
  }
  try {
    const value = JSON.parse(
      Buffer.from(id.slice(HERDR_PTY_PREFIX.length), 'base64url').toString('utf8')
    ) as Partial<HerdrPtyIdentity> | null
    if (
      !value ||
      typeof value.projectId !== 'string' ||
      typeof value.hostId !== 'string' ||
      typeof value.worktreeId !== 'string' ||
      typeof value.tabId !== 'string' ||
      typeof value.leafId !== 'string'
    ) {
      return null
    }
    return value as HerdrPtyIdentity
  } catch {
    return null
  }
}

function decodeFrame(frame: HerdrTerminalFrame): string {
  return Buffer.from(frame.bytes, 'base64').toString('utf8')
}

export async function waitForFirstHerdrFrame(
  binding: HerdrPtyBinding,
  callbacks: {
    emitData(payload: { id: string; data: string; sequenceChars: number }): void
    emitExit(payload: { id: string; code: number }): void
    detach(): void
  }
): Promise<{ frame: HerdrTerminalFrame; data: string } | null> {
  return await new Promise((resolve, reject) => {
    let first = true
    const timeout = setTimeout(() => {
      first = false
      resolve(null)
    }, 2_000)
    binding.unsubscribe.push(
      binding.controller.onFrame((frame) => {
        const data = decodeFrame(frame)
        binding.cols = frame.width
        binding.rows = frame.height
        binding.snapshot = frame.full ? data : `${binding.snapshot}${data}`
        if (first) {
          first = false
          clearTimeout(timeout)
          resolve({ frame, data })
          return
        }
        binding.sequenceChars += data.length
        callbacks.emitData({ id: binding.id, data, sequenceChars: binding.sequenceChars })
      }),
      binding.controller.onClosed(() => {
        if (binding.detached) {
          return
        }
        if (first) {
          first = false
          clearTimeout(timeout)
          callbacks.detach()
          reject(new Error('Herdr terminal controller closed before its first frame'))
          return
        }
        callbacks.detach()
        callbacks.emitExit({ id: binding.id, code: 0 })
      })
    )
  })
}
