import { pathToFileURL } from 'node:url'
import { relayOpsEnvironment } from './environment-config.js'
import { createGcloudClient } from './gcloud-client.js'
import {
  livePreflightGcloud,
  readDispatchSelector,
  waveAdjustedSelector
} from './incident-live-preflight-cli.js'
import { createIncidentSampleCollector } from './incident-monitor-sources.js'
import type { IncidentSample } from './incident-monitor.js'
import { createPreDrainHardRuleReader } from './pre-drain-hard-rule-sources.js'
import {
  preDrainSampleWindowMinutes,
  PreDrainSampleTripped,
  runPreDrainSample,
  type PreDrainHardRuleReadings
} from './pre-drain-sample.js'

const USAGE =
  'usage: --target-cell-id <cell> --target-hosts <n> --expected-selector-generation <n>' +
  ' --selector-membership-file <json> --wave-index <0-9> --selector-wave-delta <0|2>'

const OPTIONS = [
  '--target-cell-id',
  '--target-hosts',
  '--expected-selector-generation',
  '--selector-membership-file',
  '--wave-index',
  '--selector-wave-delta'
] as const

type Option = (typeof OPTIONS)[number]

const COUNT = /^(0|[1-9][0-9]*)$/

function isOption(value: string): value is Option {
  return (OPTIONS as readonly string[]).includes(value)
}

// Every option is required exactly once, so a typo can never silently shorten the window.
export function parsePreDrainSampleArgs(argv: string[]): Record<Option, string> {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const values = new Map<Option, string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? ''
    const value = args[index + 1]
    if (!isOption(name) || values.has(name) || !value) throw new Error(USAGE)
    values.set(name, value)
  }
  const get = (name: Option): string => {
    const value = values.get(name)
    if (value === undefined) throw new Error(USAGE)
    return value
  }
  const parsed = {
    '--target-cell-id': get('--target-cell-id'),
    '--target-hosts': get('--target-hosts'),
    '--expected-selector-generation': get('--expected-selector-generation'),
    '--selector-membership-file': get('--selector-membership-file'),
    '--wave-index': get('--wave-index'),
    '--selector-wave-delta': get('--selector-wave-delta')
  }
  if (
    !COUNT.test(parsed['--target-hosts']) ||
    !COUNT.test(parsed['--expected-selector-generation'])
  ) throw new Error(USAGE)
  return parsed
}

export async function runPreDrainSampleCli(
  argv: string[],
  dependencies: {
    now?: () => number
    wait?: (ms: number) => Promise<void>
    collect?: () => Promise<IncidentSample>
    readHardRules?: () => Promise<PreDrainHardRuleReadings>
    gcloud?: ReturnType<typeof createGcloudClient>
    environment?: NodeJS.ProcessEnv
    print?: (line: string) => void
  } = {}
): Promise<void> {
  const options = parsePreDrainSampleArgs(argv)
  const environment = relayOpsEnvironment('production')
  const configuredCellIds = new Set(environment.cells.map((cell) => cell.cellId))
  const targetCellId = options['--target-cell-id']
  // An unknown target would exempt nothing and make every one of its exits unattributed.
  if (!configuredCellIds.has(targetCellId)) throw new Error('pre-drain sample target cell is unknown')
  const windowMinutes = preDrainSampleWindowMinutes(Number(options['--target-hosts']))
  const expectedSelector = waveAdjustedSelector(
    await readDispatchSelector(
      options['--expected-selector-generation'],
      options['--selector-membership-file']
    ),
    options['--wave-index'],
    options['--selector-wave-delta']
  )
  const print = dependencies.print ?? ((line: string) => console.log(line))
  const gcloud = livePreflightGcloud(
    dependencies.gcloud ?? createGcloudClient(),
    dependencies.environment
  )
  const collect = dependencies.collect ?? createIncidentSampleCollector(gcloud, {
    environment: 'production',
    expectedSelector,
    ...(dependencies.now ? { now: dependencies.now } : {})
  })
  const { membership } = expectedSelector
  const readHardRules = dependencies.readHardRules ?? createPreDrainHardRuleReader(
    environment,
    () => gcloud.accessToken(),
    {
      targetCellId,
      placementCellIds: new Set([...membership.general, ...membership.migrationOnly]),
      configuredCellIds
    },
    dependencies.now ? { now: dependencies.now } : {}
  )
  print(JSON.stringify({
    event: 'relay_pre_drain_sample_window',
    targetCellId,
    targetHosts: Number(options['--target-hosts']),
    windowMinutes
  }))
  try {
    const result = await runPreDrainSample({
      windowMinutes,
      collect,
      readHardRules,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.wait ? { wait: dependencies.wait } : {}),
      log: (record) => print(JSON.stringify({ event: 'relay_pre_drain_sample', ...record }))
    })
    print(JSON.stringify({
      event: 'relay_pre_drain_sample_passed',
      windowMinutes: result.windowMinutes,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      samples: result.samples.length
    }))
  } catch (error) {
    if (error instanceof PreDrainSampleTripped) {
      print(JSON.stringify({
        event: 'relay_pre_drain_sample_tripped',
        windowMinutes,
        samples: error.samples.length,
        failures: error.failures
      }))
    }
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreDrainSampleCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'relay pre-drain sample failed')
    process.exitCode = 1
  })
}
