import { describe, expect, it } from 'vitest'
import { runCoalescedDaemonRestart, settledDaemonRestart } from './daemon-restart-state'

describe('settledDaemonRestart', () => {
  it('is undefined with no restart running', () => {
    expect(settledDaemonRestart()).toBeUndefined()
  })

  it('holds until the running restart settles, whether it succeeds or fails', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      let finish!: () => void
      const restart = runCoalescedDaemonRestart(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              outcome === 'resolve' ? resolve({ killedCount: 1 }) : reject(new Error('x'))
          })
      )
      restart.catch(() => {})
      let settled = false
      void settledDaemonRestart()?.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      finish()
      await restart.catch(() => {})
      await Promise.resolve()
      expect(settled).toBe(true)
      expect(settledDaemonRestart()).toBeUndefined()
    }
  })
})
