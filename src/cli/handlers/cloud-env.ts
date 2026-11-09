// `orca cloud env ...`: lets a local agent read the org environment, replace its install script and
// run builds. The desktop app holds the Orca Cloud session, so every call goes through its runtime.
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import {
  CLOUD_ENVIRONMENT_METHODS,
  type CloudEnvironmentBuildsData,
  type CloudEnvironmentFollowData,
  type CloudEnvironmentRpcResult,
  type CloudEnvironmentSetInstallScriptData,
  type CloudEnvironmentShowData,
  type CloudEnvironmentStartBuildData
} from '../../shared/hosted-sandbox/hosted-environment-cli-contract'
import { HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS } from '../../shared/hosted-sandbox/hosted-environment-wire'
import { formatBuilds, formatOutcome, formatShow } from './cloud-env-format'

const FOLLOW_WAIT_MS = 10_000
const FOLLOW_CALL_TIMEOUT_MS = 30_000
// `--wait --json` reports this much of the end of the log, enough to see why a build failed.
const JSON_LOG_TAIL_CHARS = 16_000
// A transient desktop hiccup should not abandon a 10-minute build.
const MAX_FOLLOW_FAILURES = 5

type Client = Pick<HandlerContext['client'], 'call'>

async function callCloud<T>(
  client: Client,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  let response
  try {
    response = await client.call<CloudEnvironmentRpcResult<T>>(
      method,
      params,
      timeoutMs ? { timeoutMs } : undefined
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca app does not support Orca Cloud environments yet. Update Orca and try again.'
      )
    }
    throw error
  }
  const result = response.result
  if (!result.ok) {
    throw new RuntimeClientError(
      `cloud_${result.error.code}`,
      result.error.message,
      result.error.reason ? { reason: result.error.reason } : undefined
    )
  }
  return result.data
}

function envParam(flags: HandlerContext['flags']): { env?: string } {
  const env = flags.get('env')
  return typeof env === 'string' && env.trim() ? { env: env.trim() } : {}
}

export const CLOUD_ENV_HANDLERS: Record<string, CommandHandler> = {
  'cloud env show': async ({ flags, client, json }) => {
    const data = await callCloud<CloudEnvironmentShowData>(client, CLOUD_ENVIRONMENT_METHODS.show, {
      ...envParam(flags),
      ...(flags.get('refresh') === true ? { refresh: true } : {})
    })
    console.log(json ? JSON.stringify(data, null, 2) : formatShow(data))
  },

  'cloud env set-install-script': async ({ flags, client, cwd, json }) => {
    const file = flags.get('file')
    if (typeof file !== 'string' || !file) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass the script with --file <path> (or --file - for stdin).'
      )
    }
    const script = file === '-' ? await readStdin() : await readScriptFile(resolve(cwd, file))
    if (script.length > HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS) {
      throw new RuntimeClientError(
        'invalid_argument',
        `The install script is ${script.length} characters; the limit is ${HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS}.`
      )
    }
    const data = await callCloud<CloudEnvironmentSetInstallScriptData>(
      client,
      CLOUD_ENVIRONMENT_METHODS.setInstallScript,
      { ...envParam(flags), script }
    )
    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    const flag = flags.get('env') ? ` --env ${data.environment.id}` : ''
    console.log(
      `Saved the install script for ${data.environment.name} (${script.length} chars, revision ${data.environment.revision}).\nBuild it with: orca cloud env build${flag} --wait`
    )
  },

  'cloud env build': async ({ flags, client, json }) => {
    const started = await callCloud<CloudEnvironmentStartBuildData>(
      client,
      CLOUD_ENVIRONMENT_METHODS.startBuild,
      envParam(flags)
    )
    if (flags.get('wait') !== true) {
      console.log(
        json
          ? JSON.stringify(started, null, 2)
          : `Started build #${started.build.number} (${started.build.id}) for ${started.environment.name}.\nFollow it with: orca cloud env logs ${started.build.number}${flags.get('env') ? ` --env ${started.environment.id}` : ''}`
      )
      return
    }
    if (!json) {
      process.stderr.write(
        `Started build #${started.build.number} (${started.build.id}) for ${started.environment.name}. Streaming its log...\n`
      )
    }
    const final = await followBuild(client, started.environment.id, started.build.id, { json })
    reportFinal(final, json)
  },

  'cloud env builds': async ({ flags, client, json }) => {
    const data = await callCloud<CloudEnvironmentBuildsData>(
      client,
      CLOUD_ENVIRONMENT_METHODS.builds,
      envParam(flags)
    )
    console.log(json ? JSON.stringify(data, null, 2) : formatBuilds(data))
  },

  'cloud env logs': async ({ flags, client, json }) => {
    const build = flags.get('build')
    if (typeof build !== 'string' || !build) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass a build number or id: orca cloud env logs <build>.'
      )
    }
    // Resolve the number to an id once, so polls skip the lookups.
    const first = await callCloud<CloudEnvironmentFollowData>(
      client,
      CLOUD_ENVIRONMENT_METHODS.followBuild,
      { ...envParam(flags), build, cursor: 0, waitMs: 0 },
      FOLLOW_CALL_TIMEOUT_MS
    )
    // Before the stream's first event there is no build view yet; the loop picks it up.
    const final = await followBuild(client, first.environment.id, first.build?.id ?? build, {
      json,
      initial: first
    })
    reportFinal(final, json, { quietSuccess: true })
  }
}

type FollowOutcome = {
  data: CloudEnvironmentFollowData
  logTail: string
}

async function followBuild(
  client: Client,
  envId: string,
  build: string,
  options: { json: boolean; initial?: CloudEnvironmentFollowData }
): Promise<FollowOutcome> {
  let tail = ''
  const take = (data: CloudEnvironmentFollowData): void => {
    if (data.truncated && !options.json) {
      process.stderr.write(
        '[orca] some log output was lost while following (dropped from the buffer, or the log restarted and lines may repeat)\n'
      )
    }
    for (const chunk of data.chunks) {
      if (options.json) {
        tail = (tail + chunk.data).slice(-JSON_LOG_TAIL_CHARS)
      } else if (chunk.stream === 'stderr') {
        process.stderr.write(chunk.data)
      } else {
        process.stdout.write(chunk.data)
      }
    }
  }
  let data = options.initial
  if (data) {
    take(data)
  }
  let cursor = data?.cursor ?? 0
  let failures = 0
  while (!data?.done) {
    try {
      data = await callCloud<CloudEnvironmentFollowData>(
        client,
        CLOUD_ENVIRONMENT_METHODS.followBuild,
        { env: envId, build: data?.build?.id ?? build, cursor, waitMs: FOLLOW_WAIT_MS },
        FOLLOW_CALL_TIMEOUT_MS
      )
      failures = 0
    } catch (error) {
      // Cloud-side refusals (not found, signed out) are final; transport hiccups get retried.
      if (
        ++failures > MAX_FOLLOW_FAILURES ||
        (error instanceof RuntimeClientError && error.code.startsWith('cloud_'))
      ) {
        throw error
      }
      await new Promise((r) => setTimeout(r, 2_000 * failures))
      continue
    }
    take(data)
    cursor = data.cursor
  }
  return { data, logTail: tail }
}

function reportFinal(
  outcome: FollowOutcome,
  json: boolean,
  options: { quietSuccess?: boolean } = {}
): void {
  const { data } = outcome
  const build = data.build
  const succeeded = build?.status === 'succeeded'
  if (json) {
    console.log(
      JSON.stringify(
        {
          environment: data.environment,
          build,
          ok: succeeded,
          ...(data.error ? { followError: data.error } : {}),
          logTail: outcome.logTail
        },
        null,
        2
      )
    )
  } else if (data.error) {
    process.stderr.write(`\n[orca] ${data.error}\n`)
  } else if (build && !(succeeded && options.quietSuccess)) {
    process.stderr.write(`\n${formatOutcome(build)}\n`)
  }
  // `logs` of a finished build succeeds whatever the build's outcome; `build --wait` reports it.
  if (data.error || (!options.quietSuccess && !succeeded)) {
    process.exitCode = 1
  }
}

async function readScriptFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    throw new RuntimeClientError('invalid_argument', `No file at ${path}.`)
  }
  // Characters, not bytes, are limited; 4 bytes per char bounds the read.
  if (info.size > HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS * 4) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${path} is too large for an install script (limit ${HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS} characters).`
    )
  }
  return readFile(path, 'utf8')
}

async function readStdin(
  stdin: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin
): Promise<string> {
  if (stdin.isTTY) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pipe the script on stdin when using --file -.'
    )
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS * 4) {
      throw new RuntimeClientError('invalid_argument', 'The install script on stdin is too large.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
