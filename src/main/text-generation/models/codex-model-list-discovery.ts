import { StringDecoder } from 'node:string_decoder'
import type { Writable } from 'node:stream'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
import type { CommitMessageModel } from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { createIncrementalNdjsonFramer } from '../../../shared/main-process-ndjson-framer'
import { createCodexAppServerRecordDispatcher } from '../../codex/app-server/codex-app-server-record-dispatch'
import { isProviderRecord } from '../../provider-process/provider-json-record'
import { listCodexModelPages } from '../../codex/structured/catalog/codex-structured-model-catalog'
import type { AgentModelProbeSpec } from '../../../shared/agent-model-probe-spec'
import { discoveredModelsResult } from './commit-message-model-discovery-policy'
import type {
  DiscoverCommitMessageModelsResult,
  SpawnedSourceControlAgentProcess
} from '../source-control-text-generation-types'

const APP_SERVER_EXIT_GRACE_MS = 1_500

export type CodexModelListDiscovery = {
  /** Feed raw stdout; the caller owns the byte budget. */
  receive: (chunk: Buffer) => void
  /** Rejects every waiting request, e.g. once the process closed. */
  fail: (error: Error) => void
  /** Visible models, or null when the listing was incomplete or empty. */
  models: Promise<CommitMessageModel[] | null>
}

// The default must be one of the listed levels; Codex's own default is low.
function listedDefaultEffort(model: AgentSessionModelOption): string {
  const listed = model.efforts.map((effort) => effort.value)
  return (
    [model.defaultEffort, 'low'].find((effort) => effort && listed.includes(effort)) ?? listed[0]
  )
}

/** `model/list` over an app-server child the caller spawned, owns and stops. */
export function startCodexModelListDiscovery(stdin: Writable): CodexModelListDiscovery {
  let nextRequestId = 1
  let failure: Error | null = null
  const write = (payload: Record<string, unknown>): void => {
    stdin.write(`${JSON.stringify(payload)}\n`)
  }
  const fail = (error: Error): void => {
    failure ??= error
    dispatcher.failPending(error)
  }
  const dispatcher = createCodexAppServerRecordDispatcher({
    handlers: {},
    writeResponse: (payload) => {
      try {
        write(payload)
      } catch {
        // A closed stdin fails the next request.
      }
    },
    onProtocolFailure: fail
  })
  const decoder = new StringDecoder('utf8')
  const framer = createIncrementalNdjsonFramer(
    (record) => {
      if (isProviderRecord(record)) {
        dispatcher.dispatch(record)
      }
    },
    (rejected) => {
      if (rejected.kind === 'line-too-long') {
        dispatcher.rejectOversized(rejected)
      }
    }
  )
  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
    failure
      ? Promise.reject(failure)
      : new Promise((resolve, reject) => {
          const id = nextRequestId++
          // The caller's process deadline bounds every request.
          dispatcher.addPending(id, { method, resolve, reject, timer: undefined })
          try {
            write(params === undefined ? { method, id } : { method, id, params })
          } catch (error) {
            dispatcher.deletePending(id)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })

  const models = (async (): Promise<CommitMessageModel[] | null> => {
    await request('initialize', {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' }
    })
    write({ method: 'initialized' })
    const listing = await listCodexModelPages((params) => request('model/list', params))
    if (!listing.complete || listing.models.length === 0) {
      return null
    }
    return listing.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.efforts.length
        ? {
            thinkingLevels: model.efforts.map((effort) => ({
              id: effort.value,
              label: effort.label
            })),
            defaultThinkingLevel: listedDefaultEffort(model)
          }
        : {}),
      ...(model.isDefault ? { isDefault: true } : {})
    }))
  })()

  return {
    receive: (chunk) => {
      try {
        framer.feed(decoder.write(chunk))
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    },
    fail,
    models
  }
}

/** Settles discovery from the listing, then ends the app-server, which would otherwise wait on stdin
 * forever. Codex rewrites its shared models cache at startup, so stdin EOF gets a grace before any kill. */
export function settleCodexModelListing(input: {
  listing: CodexModelListDiscovery
  spec: AgentModelProbeSpec
  child: SpawnedSourceControlAgentProcess
  isSettled: () => boolean
  stop: () => void
  finish: (result: DiscoverCommitMessageModelsResult) => void
}): void {
  const { child, spec } = input
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  const endAppServer = (): void => {
    try {
      child.stdin?.end()
    } catch {
      // A destroyed stdin still leaves the kill below.
    }
    if (exited) {
      return
    }
    const grace = setTimeout(input.stop, APP_SERVER_EXIT_GRACE_MS)
    child.once('exit', () => clearTimeout(grace))
  }
  void input.listing.models.then(
    (models) => {
      if (input.isSettled()) {
        return
      }
      endAppServer()
      input.finish(
        models
          ? discoveredModelsResult(spec, models)
          : { success: false, error: `${spec.label} returned an incomplete model list.` }
      )
    },
    (error: unknown) => {
      if (input.isSettled()) {
        return
      }
      endAppServer()
      console.error('[commit-message] Model discovery failed:', error)
      input.finish({
        success: false,
        error: `${spec.label} model discovery failed. Check the agent CLI configuration and try again.`
      })
    }
  )
}
