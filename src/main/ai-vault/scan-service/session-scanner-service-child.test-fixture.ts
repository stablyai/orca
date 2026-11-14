import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { vi } from 'vitest'
export class TestChild extends EventEmitter {
  sent: { type: string; id?: number }[] = []
  stderr = new EventEmitter()
  send = vi.fn((message: { type: string; id?: number }) => {
    this.sent.push(message)
    return true
  })
  kill = vi.fn(() => true)
  unref = vi.fn()
  asChild(): ChildProcess {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements only the IPC child operations exercised by the service client.
    return this as unknown as ChildProcess
  }
}
