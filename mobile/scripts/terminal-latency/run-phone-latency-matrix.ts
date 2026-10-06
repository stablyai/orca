/**
 * Runs the phone terminal latency matrix: every network profile, interleaved, `--runs` times.
 *
 * Needs, already running: the simulator app (built with the latency probes) showing the session
 * with three tabs — Claude Code, Codex, and `less` on a numbered file — on an Orca server in the
 * Docker container named by `--container`; and Metro writing to `--metro-log`.
 *
 *   tsx scripts/terminal-latency/run-phone-latency-matrix.ts --container orca-phone-host \
 *     --label direct --runs 10 --metro-log /path/metro.log --out /path/phone-direct.jsonl
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  cutImpairedNetwork,
  impairContainerNetwork,
  shapeImpairedNetwork,
  stopImpairedNetwork,
  type ImpairedNetworkPath
} from '../../../tests/e2e/helpers/impaired-network-link'
import type { NetworkLinkShape } from '../../../tests/e2e/helpers/netem-arguments'
import {
  NETWORK_TRAVEL_PROFILES,
  type NetworkTravelProfile
} from '../../../tests/e2e/helpers/network-travel-profiles'
import { phoneProbeLog } from './phone-probe-log'
import { simulatorInput, verticalStroke } from './simulator-touch-input'

const { values: options } = parseArgs({
  options: {
    container: { type: 'string' },
    network: { type: 'string' },
    label: { type: 'string' },
    runs: { type: 'string', default: '10' },
    'first-run': { type: 'string', default: '1' },
    profiles: { type: 'string' },
    'metro-log': { type: 'string' },
    /** The container running the Orca server and the stub; `--container` when they differ. */
    'host-container': { type: 'string' },
    out: { type: 'string' },
    /** Lines per answer the stub is configured to stream; the run waits for the last one. */
    'answer-lines': { type: 'string', default: '40' }
  }
})
if (!options.container || !options.label || !options['metro-log'] || !options.out) {
  throw new Error('--container, --label, --metro-log and --out are required')
}
const container = options.container
const hostContainer = options['host-container'] ?? container
const out = options.out
const label = options.label
const answerLines = Number(options['answer-lines'])

const root = path.resolve(__dirname, '..', '..', '..')
const UNSHAPED: NetworkLinkShape = { uplink: { delayMs: 0 }, downlink: { delayMs: 0 } }
const UNSHAPED_PROFILE: NetworkTravelProfile = {
  name: 'unshaped',
  describes: 'No impairment: the same network as the host',
  basis: 'The LAN case; also the floor every other profile is measured against.',
  shape: UNSHAPED
}
const allProfiles: NetworkTravelProfile[] = [
  UNSHAPED_PROFILE,
  ...Object.values(NETWORK_TRAVEL_PROFILES)
]
const wanted = options.profiles?.split(',')
const profiles = wanted ? allProfiles.filter((p) => wanted.includes(p.name)) : allProfiles

// Where things are on the session screen, as fractions of the screen.
const TAB_ORDER = ['claude', 'codex', 'pager'] as const
/** The tab strip's visible span; the buttons right of it cover the rest of the row. */
const TAB_STRIP = [0.03, 0.77] as const
const TERMINAL_MIDDLE = [0.5, 0.45] as const
/** Finger moves down the screen: the agents scroll back through their transcript. */
const LONG_DRAG = verticalStroke(0.2, 0.68, 60)
const HARD_FLICK = verticalStroke(0.2, 0.74, 9)
const RETURN_FLICK = verticalStroke(0.74, 0.2, 9)
/** Finger moves up: `less` moves forward from the top of its file. */
const PAGER_DRAG = verticalStroke(0.68, 0.2, 60)
const PAGER_FLICK = verticalStroke(0.74, 0.2, 9)
const TYPED_TAIL = 'abcdefghijklmnopq'

const input = simulatorInput(root)
const probes = phoneProbeLog(options['metro-log'])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const roundTripMs = (profile: NetworkTravelProfile): number =>
  profile.shape.uplink.delayMs + profile.shape.downlink.delayMs

type Cell = { profile: NetworkTravelProfile; run: number; link: ImpairedNetworkPath }

/** The number of the last marked line on screen in an `rx` probe line, or 0. */
function bottomMarker(line: string): number {
  const marker = line.startsWith('rx ') ? /\bbot=L(\d+)/.exec(line) : null
  return marker ? Number(marker[1]) : 0
}

/** How many numbered lines the host's stub API has served so far, to any agent. */
function stubLinesEmitted(): number {
  const health = execFileSync(
    'docker',
    ['exec', hostContainer, 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:8089/healthz'],
    { encoding: 'utf8', timeout: 15_000 }
  )
  const { linesEmitted } = JSON.parse(health)
  if (typeof linesEmitted !== 'number') {
    throw new Error(`the stub did not report linesEmitted: ${health}`)
  }
  return linesEmitted
}

function record(cell: Cell, tab: string, scenario: string, extra: object, events: string[]): void {
  appendFileSync(
    out,
    `${JSON.stringify({ label, profile: cell.profile.name, run: cell.run, tab, scenario, ...extra, events })}\n`
  )
}

/**
 * Why by position in the strip: tab titles change as the agents retitle their sessions, and the
 * strip scrolls, so neither a label nor a fixed coordinate finds a tab reliably.
 */
function tapTab(tab: (typeof TAB_ORDER)[number]): void {
  const elements = input.labelledElements()
  const first = elements.findIndex((element) => /^\d+ tabs$/.test(element.label)) + 1
  const last = elements.findIndex((element) => element.label === 'New tab')
  const tabs = elements.slice(first, last)
  if (first === 0 || tabs.length !== TAB_ORDER.length) {
    throw new Error(`Expected ${TAB_ORDER.length} tabs on screen, found ${tabs.length}`)
  }
  const frame = tabs[TAB_ORDER.indexOf(tab)]
  const from = Math.max(frame.x, TAB_STRIP[0]) + 0.03
  const to = Math.min(frame.x + frame.width, TAB_STRIP[1]) - 0.03
  input.tap((from + to) / 2, frame.y + frame.height / 2)
}

async function openTab(tab: (typeof TAB_ORDER)[number], link: ImpairedNetworkPath): Promise<void> {
  shapeImpairedNetwork(link, UNSHAPED)
  await sleep(300)
  tapTab(tab)
  await sleep(1500)
  // A tap on the terminal gives it the keyboard.
  input.tap(...TERMINAL_MIDDLE)
  await sleep(1000)
}

async function impair(cell: Cell): Promise<number> {
  const mark = probes.mark()
  shapeImpairedNetwork(cell.link, cell.profile.shape)
  await sleep(400 + 2 * roundTripMs(cell.profile))
  return mark
}

/** A three-letter code (6,859 values) that makes each typed line unique on screen. */
function typedLine(cell: Cell, tab: string): string {
  const index = cell.run * 40 + profiles.indexOf(cell.profile) * 2 + (tab === 'codex' ? 1 : 0)
  const letters = 'bcdfghjklmnprstvwxy'
  const code = [2, 1, 0]
    .map((place) => letters[Math.floor(index / letters.length ** place) % letters.length])
    .join('')
  return `zq${code}${TYPED_TAIL}`
}

async function agentScenarios(cell: Cell, tab: 'claude' | 'codex'): Promise<void> {
  const rtt = roundTripMs(cell.profile)
  await openTab(tab, cell.link)

  let mark = await impair(cell)
  const text = typedLine(cell, tab)
  for (const [index, character] of [...text].entries()) {
    input.type(character)
    // Why uneven: a steady cadence can lock to the link's delay and hide queueing.
    await sleep(60 + ((index * 37) % 100))
  }
  await sleep(1500 + 4 * rtt)
  const typed = probes.since(mark)
  record(cell, tab, 'type', { text }, typed)

  // Why ask the stub: it numbers lines across every answer it serves, to both agents, so the
  // screen's own last marker says nothing about where this answer will start.
  const answerEndMarker = stubLinesEmitted() + answerLines
  mark = probes.mark()
  const startedAt = Date.now()
  input.type('\n')
  let cut: { from: number; to: number } | null = null
  if (cell.profile.outages) {
    await sleep(3000)
    cutImpairedNetwork(cell.link)
    const from = Date.now()
    await sleep(cell.profile.outages.forSeconds * 1000)
    shapeImpairedNetwork(cell.link, cell.profile.shape)
    cut = { from, to: Date.now() }
  }
  const deadline = startedAt + 25_000 + 10 * rtt + (cut ? 3 * (cut.to - cut.from) : 0)
  let finished = false
  while (!finished && Date.now() < deadline) {
    await sleep(250)
    finished = probes.since(mark).some((line) => bottomMarker(line) >= answerEndMarker)
  }
  await sleep(1000 + 2 * rtt)
  record(cell, tab, 'stream', { startedAt, cut, finished }, probes.since(mark))

  mark = probes.mark()
  input.gesture(LONG_DRAG)
  input.tap(0.5, 0.4)
  await sleep(2500 + 5 * rtt)
  record(cell, tab, 'drag-then-tap', {}, probes.since(mark))

  mark = probes.mark()
  input.gesture(HARD_FLICK)
  await sleep(3000 + 5 * rtt)
  record(cell, tab, 'hard-flick', {}, probes.since(mark))

  shapeImpairedNetwork(cell.link, UNSHAPED)
  await sleep(300)
  for (let flick = 0; flick < 3; flick++) {
    input.gesture(RETURN_FLICK)
    await sleep(350)
  }
  await sleep(1200)
}

async function pagerScenarios(cell: Cell): Promise<void> {
  const rtt = roundTripMs(cell.profile)
  await openTab('pager', cell.link)
  input.type('g')
  await sleep(600)

  let mark = await impair(cell)
  input.gesture(PAGER_DRAG)
  await sleep(2500 + 5 * rtt)
  record(cell, 'pager', 'drag', {}, probes.since(mark))

  mark = probes.mark()
  input.gesture(PAGER_FLICK)
  await sleep(3000 + 5 * rtt)
  record(cell, 'pager', 'hard-flick', {}, probes.since(mark))

  shapeImpairedNetwork(cell.link, UNSHAPED)
  await sleep(300)
  input.type('g')
  await sleep(500)
}

async function main(): Promise<void> {
  const link = impairContainerNetwork(root, container, options.network)
  try {
    const firstRun = Number(options['first-run'])
    for (let run = firstRun; run < firstRun + Number(options.runs); run++) {
      // Why interleaved: drift in the machine or the app then spreads over every profile.
      for (const profile of profiles) {
        const cell = { profile, run, link }
        const startedAt = Date.now()
        await agentScenarios(cell, 'claude')
        await agentScenarios(cell, 'codex')
        await pagerScenarios(cell)
        console.log(
          `${label} run ${run} ${profile.name}: ${((Date.now() - startedAt) / 1000).toFixed(0)} s`
        )
      }
    }
  } finally {
    stopImpairedNetwork(link)
  }
}

void main()
