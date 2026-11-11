import type { ElectronApplication } from '@stablyai/playwright-test'
import { retryTransientMainEvaluate } from '../../../../tests/e2e/helpers/electron-main-evaluate-retry'

export type HostWork = {
  processCpuMs: number
  mainThreadEluActiveMs: number
  mainThreadTimerDelayP99Ms: number
  mainThreadTimerDelayMaxMs: number
  mainThreadTimerSamples: number
  mainThreadTimerResolutionMs: number
}

/** Harness-owned timer in main: works even where Electron reports a permanently zero ELU. */
export async function hostWorkMark(app: ElectronApplication): Promise<() => Promise<HostWork>> {
  const handle = await retryTransientMainEvaluate(() =>
    app.evaluateHandle(() => {
      const hooks = process.getBuiltinModule('node:perf_hooks')
      const node = hooks.performance
      const resolutionMs = 10
      let expected = node.now() + resolutionMs
      const delays = hooks.createHistogram()
      const timer = setInterval(() => {
        const now = node.now()
        delays.record(Math.max(1, Math.round(Math.max(0, now - expected) * 1e6)))
        expected = now + resolutionMs
      }, resolutionMs)
      timer.unref()
      return {
        cpu: process.cpuUsage(),
        elu: node.eventLoopUtilization(),
        timer,
        delays,
        resolutionMs
      }
    })
  )
  return async () => {
    try {
      return await handle.evaluate((start) => {
        clearInterval(start.timer)
        const node = process.getBuiltinModule('node:perf_hooks').performance
        const cpu = process.cpuUsage(start.cpu)
        const elu = node.eventLoopUtilization(start.elu)

        return {
          processCpuMs: (cpu.user + cpu.system) / 1000,
          // Electron may not account uv activity. Zero is unavailable, never proof of no work.
          mainThreadEluActiveMs: elu.active > 0 ? elu.active : Number.NaN,
          mainThreadTimerDelayP99Ms: start.delays.count
            ? start.delays.percentile(99) / 1e6
            : Number.NaN,
          mainThreadTimerDelayMaxMs: start.delays.count ? start.delays.max / 1e6 : Number.NaN,
          mainThreadTimerSamples: start.delays.count,
          mainThreadTimerResolutionMs: start.resolutionMs
        }
      })
    } finally {
      await handle.dispose()
    }
  }
}
