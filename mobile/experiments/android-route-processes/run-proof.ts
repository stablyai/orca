import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runProcess } from '../../../src/shared/child-process/run-process'
import { createRoute } from './vite-routes'

const serial = process.env.ANDROID_SERIAL
assert(
  serial && serial.startsWith('emulator-'),
  'Set ANDROID_SERIAL to a dedicated headless emulator'
)
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(process.env.ORCA_ROUTE_PROOF_DEDICATED, '1', 'Explicitly attest emulator ownership')
const deviceSerial = serial
const apk = resolve(
  'mobile/experiments/android-route-processes/app/build/outputs/apk/debug/app-debug.apk'
)
const evidencePath = process.env.ORCA_ROUTE_PROOF_EVIDENCE
assert(evidencePath, 'Set ORCA_ROUTE_PROOF_EVIDENCE to an output JSON path')
const packageName = 'dev.orca.routeproof'
const events: { event: string; time: number; detail?: string }[] = []
async function adb(...args: string[]) {
  const result = await runProcess({
    program: process.env.ADB ?? 'adb',
    args: ['-s', deviceSerial, ...args],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  assert.equal(result.code, 0, result.stderr + result.stdout)
  return result.stdout.trim()
}
async function waitFor(label: string, predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    if (await predicate()) {
      events.push({ event: label, time: Date.now() })
      return
    }
    await delay(250)
  }
  throw new Error('Timed out: ' + label)
}
const routes: Awaited<ReturnType<typeof createRoute>>[] = []
let installed = false
let failure: string | undefined
let logs = ''
const measurements: Record<string, string> = {}
const cleanup: { action: string; error?: string }[] = []
const reversed: number[] = []
try {
  assert.equal(await adb('shell', 'getprop', 'sys.boot_completed'), '1')
  assert.equal(
    await adb('shell', 'pm', 'list', 'packages', packageName),
    '',
    'Refusing existing installation'
  )
  await adb('install', apk)
  installed = true
  for (const name of ['a', 'b']) {
    const route = await createRoute(name)
    routes.push(route)
    await adb('reverse', '--no-rebind', `tcp:${route.proxy.port}`, `tcp:${route.proxy.port}`)
    reversed.push(route.proxy.port)
  }
  const [a, b] = routes
  assert(a && b)
  async function start(route: typeof a, stopped?: typeof a) {
    const lifecycle = () => adb('logcat', '-d', '-v', 'brief', '-s', 'RouteProof:I', '*:S')
    const previous = await lifecycle()
    await adb(
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      `${packageName}/.Route${route.route.toUpperCase()}`,
      '--ei',
      'proxyPort',
      String(route.proxy.port)
    )
    const pid = await adb('shell', 'pidof', packageName + ':route_' + route.route)
    assert.match(pid, /^\d+$/)
    const resumed = `resume route=${route.route} pid=${pid}`
    const stoppedPid = stopped
      ? await adb('shell', 'pidof', packageName + ':route_' + stopped.route)
      : undefined
    const stop = `stop route=${stopped?.route} pid=${stoppedPid}`
    const count = (text: string, message: string) =>
      text.split('\n').filter((line) => line.endsWith(message)).length
    await waitFor(
      `${route.route} resumed${stopped ? `; ${stopped.route} stopped` : ''}`,
      async () => {
        const current = await lifecycle()
        const activity = await adb('shell', 'dumpsys', 'activity', 'activities')
        return (
          count(current, resumed) > count(previous, resumed) &&
          (!stopped || count(current, stop) > count(previous, stop)) &&
          activity
            .split('\n')
            .some(
              (line) =>
                line.includes('ResumedActivity:') &&
                line.includes(`${packageName}/.Route${route.route.toUpperCase()}`)
            )
        )
      }
    )
  }
  function retainedDocuments() {
    for (const route of routes) {
      const data = route.reports.map(({ body }) => JSON.parse(body))
      assert.equal(data.filter((row) => row.kind === 'load').length, 1)
      assert(
        data.every((row) => row.page === data[0].page),
        `${route.route} document changed`
      )
    }
  }
  async function switchTo(route: typeof a, stopped: typeof a) {
    retainedDocuments()
    await start(route, stopped)
    const since = Date.now()
    await waitFor(`retained documents after switching to ${route.route}`, () =>
      routes.every((item) => item.reports.some(({ time }) => time > since))
    )
    retainedDocuments()
  }
  const has = (route: typeof a, kind: string, revision: number) =>
    route.reports.some(({ body }) => {
      const data = JSON.parse(body)
      return data.kind === kind && data.revision === revision
    })
  await start(a)
  await waitFor('a loaded', () => has(a, 'load', 1))
  await start(b, a)
  await waitFor('b loaded', () => has(b, 'load', 1))
  retainedDocuments()
  const pidA = await adb('shell', 'pidof', packageName + ':route_a')
  const pidB = await adb('shell', 'pidof', packageName + ':route_b')
  assert.match(pidA, /^\d+$/)
  assert.match(pidB, /^\d+$/)
  assert.notEqual(pidA, pidB)
  events.push({ event: 'distinct processes', time: Date.now(), detail: `${pidA},${pidB}` })
  measurements.routeA = await adb('shell', 'dumpsys', 'meminfo', pidA)
  measurements.routeB = await adb('shell', 'dumpsys', 'meminfo', pidB)
  measurements.processes = await adb('shell', 'ps', '-A')
  const before = Date.now()
  await a.revision(2)
  await b.revision(2)
  await waitFor('both HMR while b foreground', () => has(a, 'hmr', 2) && has(b, 'hmr', 2))
  await waitFor('both fetching concurrently', () =>
    routes.every(
      (route) =>
        route.reports.filter(
          (report) => report.time > before && JSON.parse(report.body).kind === 'fetch'
        ).length >= 3
    )
  )
  await switchTo(a, b)
  await a.revision(3)
  await b.revision(3)
  await waitFor('both HMR after switching to a', () => has(a, 'hmr', 3) && has(b, 'hmr', 3))
  await switchTo(b, a)
  await adb('shell', 'run-as', packageName, 'kill', '-9', pidA)
  await waitFor('a process exited', async () => {
    const output = await adb('shell', 'ps', '-A')
    return !output.split('\n').some((line) => line.trim().endsWith(packageName + ':route_a'))
  })
  await b.revision(4)
  await waitFor('b survives a death', () => has(b, 'hmr', 4))
  await start(a)
  await waitFor('a recovered', () => has(a, 'load', 3))
  const newPid = await adb('shell', 'pidof', packageName + ':route_a')
  assert.notEqual(newPid, pidA)
  assert.equal(await adb('shell', 'pidof', packageName + ':route_b'), pidB)
  events.push({ event: 'recovered pid', time: Date.now(), detail: newPid })
  await a.revision(4)
  await waitFor('recovered a HMR', () => has(a, 'hmr', 4))
  for (const route of routes) {
    assert(route.targets.length > 0)
    const data = route.reports.map((report) => JSON.parse(report.body))
    assert(
      data.every(
        (row) =>
          row.route === route.route &&
          row.stored === route.route &&
          row.cookie === `route=${route.route}` &&
          row.url === 'http://localhost:5173/'
      )
    )
    assert(data.every((row) => row.page === data[0].page || route === a))
    const loads = data.filter((row) => row.kind === 'load')
    assert.equal(loads[0].previous, null)
    assert.equal(loads[0].previousCookie, '')
    if (route === a) {
      assert.equal(loads.length, 2)
      assert.equal(loads[1].previous, 'a')
      assert.equal(loads[1].previousCookie, 'route=a')
    } else {
      assert.equal(loads.length, 1)
    }
  }
  events.push({ event: 'storage isolation and recovery passed', time: Date.now() })
} catch (error) {
  failure = String(error)
  process.exitCode = 1
} finally {
  logs = await adb('logcat', '-d', '-s', 'RouteProof:I', '*:S').catch(String)
  async function clean(action: string, operation: () => Promise<unknown>) {
    try {
      await operation()
      cleanup.push({ action })
    } catch (error) {
      cleanup.push({ action, error: String(error) })
      process.exitCode = 1
    }
  }
  if (installed) {
    await clean('uninstall test APK', () => adb('uninstall', packageName))
  }
  for (const port of reversed) {
    await clean('remove reverse ' + port, () => adb('reverse', '--remove', `tcp:${port}`))
  }
  for (const route of routes) {
    await clean('close route ' + route.route, () => route.close())
  }
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        failure,
        serial,
        events,
        logs,
        measurements,
        cleanup,
        routes: routes.map(({ route, reports, targets }) => ({ route, reports, targets }))
      },
      null,
      2
    )
  )
}
console.log(
  failure ??
    (cleanup.some((row) => row.error)
      ? 'FAIL: cleanup errors in evidence'
      : 'PASS: separate processes, same URL, concurrent fetch/HMR, switching, death/recovery, storage')
)
