import { parentPort } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'
import { nativeChatLineDecoderForAgent } from '../transcript-decoding/native-chat-line-decoder'
import {
  countNativeChatFindSources,
  NativeChatTranscriptFindScan,
  type NativeChatFindSource
} from './native-chat-transcript-find-scan'
import type {
  NativeChatTranscriptFindCommand,
  NativeChatTranscriptFindResponse
} from './native-chat-transcript-find-protocol'

installWorkerSendLedger('orca-native-chat-find')

/** Typing in one chat re-counts the copy kept from the last read instead of decoding it again;
 *  bounded so a long chat's words are not held. */
const KEPT_SOURCES_MAX = 8192
const KEPT_TEXT_MAX = 2 * 1024 * 1024

let kept: { version: string; sources: readonly NativeChatFindSource[] } | null = null
const scans = new Map<
  number,
  { version: string; query: string; scan: NativeChatTranscriptFindScan }
>()

function send(response: NativeChatTranscriptFindResponse): void {
  parentPort?.postMessage(response)
}

function handle(command: NativeChatTranscriptFindCommand): void {
  if (command.type === 'search') {
    if (kept?.version === command.version) {
      send({
        type: 'done',
        id: command.id,
        documents: countNativeChatFindSources(kept.sources, command.query)
      })
      return
    }
    const decode = nativeChatLineDecoderForAgent(command.agent)
    if (!decode) {
      send({ type: 'failed', id: command.id, error: 'Transcript unavailable' })
      return
    }
    scans.set(command.id, {
      version: command.version,
      query: command.query,
      scan: new NativeChatTranscriptFindScan(command.filePath, decode)
    })
    send({ type: 'need-bytes', id: command.id })
    return
  }
  const pending = scans.get(command.id)
  if (!pending) {
    return
  }
  if (command.type === 'cancel') {
    scans.delete(command.id)
    return
  }
  if (command.type === 'chunk') {
    pending.scan.push(Buffer.from(command.bytes))
    send({ type: 'ack', id: command.id })
    return
  }
  scans.delete(command.id)
  const sources = pending.scan.end()
  kept =
    sources.length <= KEPT_SOURCES_MAX && pending.scan.textBytes <= KEPT_TEXT_MAX
      ? { version: pending.version, sources }
      : null
  send({
    type: 'done',
    id: command.id,
    documents: countNativeChatFindSources(sources, pending.query)
  })
}

parentPort?.on('message', (command: NativeChatTranscriptFindCommand) => {
  try {
    handle(command)
  } catch (error) {
    scans.delete(command.id)
    send({
      type: 'failed',
      id: command.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
