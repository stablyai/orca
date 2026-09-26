import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

export type WindowsBunPtySpawnReceipt = { pid: number } | { error: string }

export class WindowsBunPtySpawnUnconfirmedError extends Error {}

function publishReceipt(path: string, value: string): void {
  const pending = `${path}.pending`
  writeFileSync(pending, value, { flag: 'wx', mode: 0o600 })
  // ConPTY cannot inherit Bun IPC; publish the receipt atomically.
  renameSync(pending, path)
}

export function publishWindowsBunPtyShellPid(path: string, pid: number): void {
  publishReceipt(path, String(pid))
}

export function publishWindowsBunPtySpawnError(path: string, error: unknown): void {
  publishReceipt(`${path}.error`, error instanceof Error ? error.message : String(error))
}

export function readWindowsBunPtySpawnReceipt(path: string): WindowsBunPtySpawnReceipt | undefined {
  try {
    const receipt = readFileSync(path, 'utf8')
    const pid = Number(receipt)
    if (/^[1-9][0-9]{0,9}$/.test(receipt) && Number.isSafeInteger(pid) && pid <= 0xffff_ffff) {
      return { pid }
    }
  } catch {
    // Missing or unreadable identity never proves the shell failed to spawn.
  }
  try {
    return { error: readFileSync(`${path}.error`, 'utf8') }
  } catch {
    return undefined
  }
}

export async function waitForWindowsBunPtySpawn(
  readReceipt: () => WindowsBunPtySpawnReceipt | undefined,
  wrapperExited: Promise<number>
): Promise<void> {
  let ended = false
  const markEnded = (): void => {
    ended = true
  }
  void wrapperExited.then(markEnded, markEnded)
  const deadline = Date.now() + 30_000
  while (true) {
    const receipt = readReceipt()
    if (receipt) {
      if ('pid' in receipt) {
        return
      }
      if (ended) {
        throw new Error(receipt.error)
      }
    }
    if (ended || Date.now() >= deadline) {
      // An unreported shell may already have run a startup command; never retry it.
      throw new WindowsBunPtySpawnUnconfirmedError('Windows shell spawn could not be confirmed')
    }
    await delay(5)
  }
}
