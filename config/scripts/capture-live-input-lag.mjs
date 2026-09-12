import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startRendererTimingProbe,
  stopRendererTimingProbe
} from './idle-cpu-renderer-timing-probe.mjs'

// Called with an already-attached main Orca page; never launches, focuses, or reloads it.
export async function captureLiveInputLag(page, durationMs = 30_000) {
  if (!Number.isFinite(durationMs) || durationMs < 1_000 || durationMs > 60_000) {
    throw new Error('Capture duration must be 1–60 seconds')
  }
  const identity = await page.evaluate(async () => {
    if (!window.api?.app?.getIdentity) {
      throw new Error('Target is not the main Orca renderer')
    }
    if (window.__orcaLiveInputLag || window.__orcaIdleCpuTimingProbe) {
      throw new Error('A renderer timing probe already exists; stop it before capturing')
    }
    return window.api.app.getIdentity()
  })
  const directory = await mkdtemp(join(tmpdir(), 'orca-input-lag-'))
  const cdp = await page.context().newCDPSession(page)
  let timingStarted = false
  let inputStarted = false
  let profilingStarted = false
  try {
    await startRendererTimingProbe(page)
    timingStarted = true
    await page.evaluate(() => {
      const events = []
      const frames = []
      const observers = []
      const maxEntries = 3_000
      let dropped = 0
      const retain = (list, value) => {
        if (list.length < maxEntries) {
          list.push(value)
        } else {
          dropped++
        }
      }
      const surface = (target) => {
        if (!(target instanceof Element)) {
          return 'other'
        }
        if (target.closest('.xterm')) {
          return 'terminal'
        }
        if (target.closest('.monaco-editor')) {
          return 'editor'
        }
        if (target.closest('[contenteditable="true"]')) {
          return 'contenteditable'
        }
        return target.matches('input, textarea') ? 'text-input' : 'other'
      }
      const onInput = (event) => {
        retain(events, {
          kind: 'listener',
          type: event.type,
          surface: surface(event.target),
          eventAt: event.timeStamp,
          handlerAt: performance.now(),
          trusted: event.isTrusted
        })
      }
      const types = ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend']
      for (const type of types) {
        document.addEventListener(type, onInput, true)
      }
      const supported = PerformanceObserver.supportedEntryTypes ?? []
      if (supported.includes('event')) {
        const observer = new PerformanceObserver((list) => {
          for (const event of list.getEntries()) {
            if (!types.includes(event.name)) {
              continue
            }
            retain(events, {
              kind: 'event-timing',
              type: event.name,
              surface: surface(event.target),
              eventAt: event.startTime,
              processingStart: event.processingStart,
              processingEnd: event.processingEnd,
              duration: event.duration,
              interactionId: event.interactionId
            })
          }
        })
        observer.observe({ type: 'event', durationThreshold: 16 })
        observers.push(observer)
      }
      let last = performance.now()
      let frameId
      const frame = (now) => {
        if (now - last > 32) {
          retain(frames, { at: now, gapMs: now - last })
        }
        last = now
        frameId = requestAnimationFrame(frame)
      }
      frameId = requestAnimationFrame(frame)
      const startedAt = performance.now()
      const startedAtIso = new Date().toISOString()
      window.__orcaLiveInputLag = {
        stop: () => {
          cancelAnimationFrame(frameId)
          for (const type of types) {
            document.removeEventListener(type, onInput, true)
          }
          for (const observer of observers) {
            observer.disconnect()
          }
          delete window.__orcaLiveInputLag
          return {
            startedAt,
            startedAtIso,
            endedAt: performance.now(),
            visibility: document.visibilityState,
            events,
            frames,
            dropped,
            eventTimingSupported: supported.includes('event')
          }
        }
      }
    })
    inputStarted = true
    await cdp.send('Profiler.enable')
    const profileStartWindow = [await page.evaluate(() => performance.now())]
    await cdp.send('Profiler.start')
    profilingStarted = true
    profileStartWindow.push(await page.evaluate(() => performance.now()))
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    const { profile } = await cdp.send('Profiler.stop')
    profilingStarted = false
    const input = await page.evaluate(() => window.__orcaLiveInputLag.stop())
    inputStarted = false
    const timing = await stopRendererTimingProbe(page)
    await page.evaluate(() => {
      delete window.__orcaIdleCpuTimingProbe
    })
    timingStarted = false
    await writeFile(join(directory, 'renderer.cpuprofile'), JSON.stringify(profile), {
      mode: 0o600
    })
    await writeFile(
      join(directory, 'input-timing.json'),
      JSON.stringify(
        {
          identity,
          input,
          timing,
          profileStartWindow,
          limitation:
            'Keyboard dispatch, handlers and frames only; not PTY echo latency. Event Timing omits short events and rounds durations.'
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    return { directory, eventRecords: input.events.length, slowFrames: input.frames.length, timing }
  } finally {
    if (profilingStarted) {
      await cdp.send('Profiler.stop').catch(() => {})
    }
    if (inputStarted) {
      await page.evaluate(() => window.__orcaLiveInputLag?.stop()).catch(() => {})
    }
    if (timingStarted) {
      await stopRendererTimingProbe(page).catch(() => {})
      await page
        .evaluate(() => {
          delete window.__orcaIdleCpuTimingProbe
        })
        .catch(() => {})
    }
    await cdp.send('Profiler.disable').catch(() => {})
    await cdp.detach().catch(() => {})
  }
}
