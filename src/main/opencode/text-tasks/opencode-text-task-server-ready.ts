import { z } from 'zod'
import { SearchSubprocessLineAccumulator } from '../../../shared/search-subprocess-lines'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../../text-generation/source-control-generation-limits'
import type { SpawnedSourceControlAgentProcess } from '../../text-generation/source-control-text-generation-types'
const lease = z.object({ url: z.url() })

export function readOpenCodeTextTaskServerUrl(
  child: SpawnedSourceControlAgentProcess,
  v2: boolean,
  signal: AbortSignal
): Promise<string> {
  const ready = Promise.withResolvers<string>()
  const lines = new SearchSubprocessLineAccumulator(MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES)
  let bytes = 0
  let listening = false
  child.stdout?.on('data', (chunk: Buffer) => {
    if (listening) {
      return
    }
    bytes += chunk.byteLength
    if (bytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
      ready.reject(new Error('OpenCode server readiness exceeded its output limit'))
      return
    }
    lines.push(chunk, (line) => {
      if (listening) {
        return
      }
      let url: string | undefined
      if (v2) {
        try {
          url = lease.parse(JSON.parse(line)).url
        } catch {
          return
        }
      } else {
        url = line.match(/^opencode server listening on (http:\/\/\S+)/)?.[1]
      }
      if (!url) {
        return
      }
      let address: URL
      try {
        address = new URL(url)
      } catch {
        ready.reject(new Error('OpenCode private server returned an unexpected address'))
        return
      }
      if (
        address.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
      ) {
        ready.reject(new Error('OpenCode private server returned an unexpected address'))
        return
      }
      listening = true
      ready.resolve(address.origin)
    })
  })
  // Readiness output can contain credentials; never retain or log either stream.
  child.stderr?.on('data', () => {})
  child.once('error', (error) => ready.reject(error))
  child.once('close', () => ready.reject(new Error('OpenCode private server exited')))
  return waitForPromiseWithSignal(ready.promise, signal).finally(() => lines.clear())
}
